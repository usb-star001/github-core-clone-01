// app.ts — the forge's HTTP server: one Store, four surfaces, one process.
// Routing:
//   GET  /healthz            200 {"ok": true}, no auth
//   POST /mcp                MCP (JSON-RPC 2.0 Streamable HTTP)
//   POST /api/graphql        GraphQL v4
//   /api/v3/...              REST v3 (auth except /, /meta, /user)
//   /{owner}/{repo}.git/...  git smart HTTP (auth)
//   anything else            404 {"message": "Not Found"}
//
// Auth is Bearer MAKEFUN_SHOP_TOKEN. When the variable is unset (local
// testing) any non-empty bearer token is accepted, so curl can drive the
// server with `Authorization: Bearer test`. The viewer login defaults to
// adaiversen (the scenario seed's viewer) and is learned from the first
// authenticated owner-bearing request, because the token itself does not
// encode the login.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { handleGit, parseGitPath } from './git-http.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** True when the request carries a bearer token the trial accepts. */
function isAuthenticated(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (EXPECTED_TOKEN === '') return true; // local testing: any non-empty token
  return token === EXPECTED_TOKEN;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    ...extraHeaders,
  });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

export function createApp(): Server {
  const store = new Store('adaiversen');
  let requestCounter = 0;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        await handleRequest(store, req, res, () => {
          requestCounter += 1;
          return `req-${requestCounter}-${randomUUID()}`;
        });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        } else {
          res.end();
        }
      }
    })();
  });
  return server;
}

async function handleRequest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  newRequestId: () => string,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const query = url.searchParams;
  const host = req.headers.host ?? '127.0.0.1';
  const baseUrl = `http://${host}`;
  const authenticated = isAuthenticated(req);

  // -- health -----------------------------------------------------------------
  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // -- MCP --------------------------------------------------------------------
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const body = await readBody(req);
    const outcome = handleMcp(store, body, authenticated);
    if (outcome.body === null) {
      res.writeHead(outcome.status, { 'content-length': 0 });
      res.end();
      return;
    }
    sendJson(res, outcome.status, outcome.body);
    return;
  }

  // -- GraphQL ----------------------------------------------------------------
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authenticated) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    const outcome = handleGraphQL(store, parsed);
    sendJson(res, outcome.status, outcome.body, { 'x-github-request-id': newRequestId() });
    return;
  }

  // -- REST -------------------------------------------------------------------
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
    const segments = restPath === '' ? [] : restPath.split('/').map((s) => decodeURIComponent(s));
    const isPublic = segments.length === 0 || (segments.length === 1 && (segments[0] === 'meta' || segments[0] === 'user'));
    if (!isPublic && !authenticated) {
      sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': newRequestId() });
      return;
    }
    // Learn the token owner's login from the first authenticated repo route.
    if (authenticated && segments[0] === 'repos' && segments[1] !== undefined) {
      store.learnViewerLogin(segments[1]);
    }
    const raw = await readBody(req);
    let body: unknown;
    if (raw.length === 0) {
      body = undefined;
    } else {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = '__parseError';
      }
    }
    const outcome = handleRest(store, { method, segments, query, body, baseUrl });
    const headers: Record<string, string> = {
      'x-github-request-id': newRequestId(),
      'x-oauth-scopes': 'repo, read:user, user',
      ...(outcome.headers ?? {}),
    };
    sendJson(res, outcome.status, outcome.body, headers);
    return;
  }

  // -- git smart HTTP ---------------------------------------------------------
  const gitRoute = parseGitPath(path);
  if (gitRoute !== null) {
    if (!authenticated) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    store.learnViewerLogin(gitRoute.owner);
    const body = await readBody(req);
    // The Git-Protocol header carries "version=2" (not just "2").
    const gitProtocolRaw = req.headers['git-protocol'] ?? '';
    const gitProtocol = gitProtocolRaw.replace(/^version=/, '');
    const outcome = handleGit(store, gitRoute, method, query, gitProtocol, body);
    sendBuffer(res, outcome.status, outcome.contentType, outcome.body);
    return;
  }

  // -- anything else ----------------------------------------------------------
  sendJson(res, 404, { message: 'Not Found' });
}

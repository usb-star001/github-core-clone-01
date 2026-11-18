// mcp.ts — Model Context Protocol at /mcp (JSON-RPC 2.0 Streamable HTTP).
//
// Supports the 2026-07-28 revision (server/discover) with a legacy
// 2025-11-25 fallback (initialize + notifications/initialized). The tools
// act on the same store as REST, so a repo or issue created over MCP is the
// same object over REST. Auth is checked before the tool exists: a tools/call
// without a bearer token is HTTP 401.

import { type Repo, type Store } from './store.ts';

export interface McpOutcome {
  status: number;
  body: unknown; // null means an empty body
}

// ---------------------------------------------------------------------------------------------
// tool catalogue (fixed and deterministic: two tools/list answers are byte-identical)
// ---------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The name of the head branch.' },
        base: { type: 'string', description: 'The name of the base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function lookupRepo(store: Store, args: Record<string, unknown>): Repo {
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? '');
  if (owner !== store.viewerLogin) throw new Error(`Repository ${owner}/${repoName} not found`);
  const repo = store.getRepo(repoName);
  if (!repo) throw new Error(`Repository ${owner}/${repoName} not found`);
  return repo;
}

function requiredArg(args: Record<string, unknown>, name: string): unknown {
  const value = args[name];
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}

function mergePullRequest(store: Store, repo: Repo, pullNumber: number): Record<string, unknown> {
  const pull = repo.pulls.get(pullNumber);
  if (!pull) throw new Error(`Pull request #${pullNumber} not found`);
  if (pull.merged) {
    return { merged: true, sha: pull.mergeCommitSha ?? pull.baseSha, number: pull.number, message: 'Pull request already merged' };
  }
  if (pull.state !== 'open') throw new Error(`Pull request #${pullNumber} is not open`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) throw new Error('Head or base branch does not exist');
  const mergeBase = store.mergeBase(repo, headTip, baseTip);
  if (mergeBase === null) throw new Error('No merge base between head and base');
  const conflicts = store.mergeConflicts(repo, mergeBase, headTip, baseTip);
  if (conflicts.length > 0) throw new Error(`Merge conflict in: ${conflicts.join(', ')}`);
  const mergeSha = store.squashMerge(repo, pull.baseRef, baseTip, mergeBase, headTip, `Merge pull request #${pull.number} from ${pull.headRef}`);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = mergeSha;
  pull.baseSha = mergeSha;
  return { merged: true, sha: mergeSha, number: pull.number, message: 'Pull request successfully merged' };
}

// Dispatch a tools/call. Returns the result payload (structuredContent).
function callTool(store: Store, name: string, args: Record<string, unknown>): unknown {
  const normalized = normalizeName(name);
  switch (normalized) {
    case 'createrepo': {
      const repoName = String(requiredArg(args, 'name'));
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      let repo = store.getRepo(repoName);
      if (!repo) {
        repo = store.createRepo(repoName, { private: isPrivate, description });
        if (!repo) throw new Error(`Repository ${repoName} already exists`);
      }
      return repoJson(repo);
    }
    case 'getrepo': {
      const repo = lookupRepo(store, args);
      return repoJson(repo);
    }
    case 'createissue': {
      const repo = lookupRepo(store, args);
      const title = String(requiredArg(args, 'title'));
      const body = typeof args.body === 'string' ? args.body : '';
      const issue = store.createIssue(repo, title, body, []);
      return {
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: [],
        created_at: new Date().toISOString(),
      };
    }
    case 'listissues': {
      const repo = lookupRepo(store, args);
      let issues = [...repo.issues.values()];
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      if (state !== 'all') {
        issues = issues.filter((issue) => issue.state === state);
      }
      issues.sort((a, b) => a.number - b.number);
      return issues.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels,
      }));
    }
    case 'createpullrequest': {
      const repo = lookupRepo(store, args);
      const title = String(requiredArg(args, 'title'));
      const head = String(requiredArg(args, 'head'));
      const base = String(requiredArg(args, 'base'));
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha) throw new Error(`Head branch ${head} does not exist`);
      if (!baseSha) throw new Error(`Base branch ${base} does not exist`);
      const existing = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (existing) {
        return {
          number: existing.number,
          state: existing.state,
          title: existing.title,
          head: { ref: existing.headRef, sha: existing.headSha },
          base: { ref: existing.baseRef, sha: existing.baseSha },
        };
      }
      const pull = store.createPull(repo, head, headSha, base, baseSha, title, '');
      return {
        number: pull.number,
        state: pull.state,
        title: pull.title,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
      };
    }
    case 'mergepullrequest': {
      const repo = lookupRepo(store, args);
      const raw = args.pull_number ?? args.pullNumber ?? args.number;
      if (raw === undefined || raw === null || raw === '') throw new Error('Missing required argument: pull_number');
      const pullNumber = Number(raw);
      if (!Number.isInteger(pullNumber)) throw new Error('pull_number must be an integer');
      return mergePullRequest(store, repo, pullNumber);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };

/**
 * Handle one POST /mcp request. `authorized` is true when a bearer token was
 * presented. Returns the HTTP status and the JSON body (null = empty body).
 */
export function handleMcp(store: Store, rawBody: Buffer, authorized: boolean): McpOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // Try to salvage the request id for the -32700 reply.
    const text = rawBody.toString('utf8');
    const match = /"id"\s*:\s*("[^"]*"|-?\d+)/.exec(text);
    let id: unknown = null;
    if (match) {
      try {
        id = JSON.parse(match[1]);
      } catch {
        id = null;
      }
    }
    return { status: 400, body: { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id ?? null;
  const isNotification = !('id' in request) || request.id === undefined;
  const method = request.method;
  if (typeof method !== 'string') {
    return { status: 400, body: { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } } };
  }
  if (isNotification) {
    // Notifications are acknowledged with 202 and no body.
    return { status: 202, body: null };
  }
  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const protocolVersion =
      typeof params.protocolVersion === 'string' &&
      (params.protocolVersion === '2026-07-28' || params.protocolVersion === '2025-11-25')
        ? params.protocolVersion
        : '2026-07-28';
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  // tools/list and tools/call touch data: auth first.
  if (method === 'tools/list' || method === 'tools/call') {
    if (!authorized) {
      return { status: 401, body: { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } } };
    }
    if (method === 'tools/list') {
      return rpcResult(id, { tools: TOOLS });
    }
    const params = (request.params ?? {}) as Record<string, unknown>;
    const name = params.name;
    if (typeof name !== 'string' || name === '') {
      return rpcError(id, -32602, 'tools/call needs a tool name');
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = callTool(store, name, args);
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith('Unknown tool:')) {
        return rpcError(id, -32602, message);
      }
      if (message.startsWith('Missing required argument:')) {
        return rpcError(id, -32602, message);
      }
      return rpcError(id, -32602, message);
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

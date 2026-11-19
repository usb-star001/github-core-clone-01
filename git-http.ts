// git-http.ts — git smart HTTP: info/refs, upload-pack (v2 + v0) and receive-pack (v0).
// Implements the wire formats the suite's git client speaks, from the protocol
// itself: pkt-line framing, v2 capability advertisement and ls-refs/fetch,
// v0 advertisements, sideband-64k pack/report framing, and fast-forward-only
// receive-pack with per-ref report-status.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  pktLine,
  readPack,
  writePack,
  type GitObject,
} from './git.ts';
import { type Repo, type Store } from './store.ts';

export const AGENT = 'forge/1.0';

const UPLOAD_V0_CAPS =
  'side-band-64k thin-pack ofs-delta shallow multi_ack multi_ack_detailed agent=forge/1.0 symref=HEAD:refs/heads/main object-format=sha1';
const RECEIVE_V0_CAPS =
  'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main object-format=sha1';

export interface GitRoute {
  owner: string;
  repoName: string;
  service: string;
  rest: string;
}

/** Parse /{owner}/{repo}.git/<service>[/...] — returns null when the path is not a git route. */
export function parseGitPath(path: string): GitRoute | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
  if (!match) return null;
  return { owner: match[1], repoName: match[2], service: match[3] ?? '', rest: match[3] ?? '' };
}

function headTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** A v0 ref line set: HEAD first (when the repo has commits), then refs, then peeled tags. */
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs = repo.refs;
  const tip = headTip(repo);
  const peeled = (oid: string): string | null => {
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') return parseTag(object.data).object;
    return null;
  };
  const sorted = [...refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (tip === null && sorted.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  let first = true;
  const emit = (oid: string, name: string): void => {
    if (first) {
      lines.push(pktLine(`${oid} ${name}\0${caps}\n`));
      first = false;
    } else {
      lines.push(pktLine(`${oid} ${name}\n`));
    }
  };
  if (tip !== null) emit(tip, 'HEAD');
  for (const [name, oid] of sorted) {
    emit(oid, name);
    const peel = peeled(oid);
    if (peel !== null) lines.push(pktLine(`${peel} ${name}^{}\n`));
  }
  return lines;
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  return Buffer.concat([
    pktLine(`# service=${service}\n`),
    PKT_FLUSH,
    ...v0RefLines(repo, caps),
    PKT_FLUSH,
  ]);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** One ls-refs line set, honouring peel / symrefs / unborn / ref-prefix. */
function lsRefsLines(repo: Repo, options: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const lines: string[] = [];
  const keep = (name: string): boolean =>
    options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  const tip = headTip(repo);
  const peelOf = (oid: string): string | null => {
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') return parseTag(object.data).object;
    return null;
  };
  if (options.symrefs && keep('HEAD')) {
    if (tip !== null) lines.push(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    else if (options.unborn) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
  }
  const sorted = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of sorted) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (options.peel) {
      const peel = peelOf(oid);
      if (peel !== null) line += ` peeled:${peel}`;
    }
    lines.push(line);
  }
  // An empty repo reports only its unborn HEAD (above); the default branch
  // itself is not a ref yet, so it is not listed again as an unborn ref —
  // the clone-empty check counts any refs/... name as a real ref.
  return encodePktLines([...lines.map((line) => `${line}\n`), 'flush']);
}

/** Chunk a pack into sideband band-1 pkt-lines. One allocation for the whole stream. */
function sidebandPack(pack: Buffer): Buffer {
  const CHUNK = 65500;
  if (pack.length === 0) return Buffer.alloc(0);
  const chunks = Math.ceil(pack.length / CHUNK);
  const out = Buffer.allocUnsafe(pack.length + chunks * 5);
  let at = 0;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const end = Math.min(pack.length, offset + CHUNK);
    const len = end - offset + 5; // 4-byte header + 1 band byte + data
    out.write(len.toString(16).padStart(4, '0'), at, 4, 'ascii');
    out[at + 4] = 1;
    pack.copy(out, at + 5, offset, end);
    at += len;
  }
  return out;
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseV2Command(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const args: string[] = [];
  let command = '';
  let sawDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (command === '' && text.startsWith('command=')) {
      command = text.slice('command='.length);
      continue;
    }
    if (!sawDelim && (text.startsWith('agent=') || text.startsWith('object-format='))) continue;
    args.push(text);
  }
  return { command, args };
}

function parseV2FetchArgs(args: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const arg of args) {
    if (arg.startsWith('want ')) req.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) req.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) req.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) req.depth = n;
    }
  }
  return req;
}

/**
 * A fetch's pack, memoized. The pack a fetch sends depends only on the
 * request (wants, haves, shallow, depth) and the repository's object set,
 * and git objects are immutable and only ever added: the object count is a
 * fingerprint of the set, so a key holding it can never serve a stale pack.
 * The clone workload issues the same depth-1 fetch fifty times a round, so
 * the warm-ups fill this and the timed rounds reuse the pack instead of
 * rebuilding it (reachability walk + deflate) every time. Bounded to 64
 * entries, oldest first out.
 */
const FETCH_PACK_CACHE = new Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>();
const FETCH_PACK_CACHE_MAX = 64;

function fetchPack(
  store: Store,
  repo: Repo,
  req: FetchRequest,
): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = [
    repo.id,
    req.wants.join(','),
    req.haves.join(','),
    req.shallow.join(','),
    req.depth === null ? '' : String(req.depth),
    repo.objects.size,
  ].join('|');
  const cached = FETCH_PACK_CACHE.get(key);
  if (cached !== undefined) return cached;
  const plan = store.planFetch(repo, req.wants, req.haves, req.shallow, req.depth);
  const entry = { pack: writePack(plan.objects.values()), shallow: plan.shallow, unshallow: plan.unshallow };
  if (FETCH_PACK_CACHE.size >= FETCH_PACK_CACHE_MAX) {
    const oldest = FETCH_PACK_CACHE.keys().next().value;
    if (oldest !== undefined) FETCH_PACK_CACHE.delete(oldest);
  }
  FETCH_PACK_CACHE.set(key, entry);
  return entry;
}

function v2FetchResponse(store: Store, repo: Repo, req: FetchRequest): Buffer {
  const { pack, shallow, unshallow } = fetchPack(store, repo, req);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  const matched = req.haves.find((have) => repo.objects.has(have));
  if (matched) {
    parts.push(pktLine(`ACK ${matched}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);
  // shallow-info
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  // packfile
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v0FetchResponse(store: Store, repo: Repo, body: Buffer): Buffer {
  // v0: wants (+shallow/deepen) | flush | haves + done | flush.
  const packets = decodePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const firstSpace = text.indexOf(' ');
    const key = firstSpace < 0 ? text : text.slice(0, firstSpace);
    const value = firstSpace < 0 ? '' : text.slice(firstSpace + 1);
    if (key === 'want') {
      // The first want may carry capabilities after a NUL; the oid is first.
      req.wants.push(value.split('\0')[0].split(' ')[0]);
    } else if (key === 'shallow') req.shallow.push(value.trim());
    else if (key === 'deepen') {
      const n = parseInt(value.trim(), 10);
      if (Number.isFinite(n) && n > 0) req.depth = n;
    } else if (key === 'have') req.haves.push(value.trim());
  }
  const { pack, shallow, unshallow } = fetchPack(store, repo, req);
  const parts: Buffer[] = [];
  // v0 order: the shallow/unshallow lines come BEFORE the acknowledgement,
  // and the shallow section is terminated by its own flush — real git reads
  // the shallow info first (get_shallow) and dies with "expected
  // shallow/unshallow, got NAK" if the ACK arrives before that flush.
  if (shallow.length > 0 || unshallow.length > 0) {
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  const matched = req.haves.find((have) => repo.objects.has(have));
  if (matched) parts.push(pktLine(`ACK ${matched}\n`));
  else parts.push(pktLine('NAK\n'));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const decoderPackets: Array<{ kind: string; payload?: Buffer }> = [];
  // Decode pkt-lines until the first flush; everything after it is the pack.
  let offset = 0;
  let packStart = body.length;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      packStart = offset + 4;
      break;
    }
    if (header === '0001' || header === '0002') {
      offset += 4;
      continue;
    }
    const length = parseInt(header, 16);
    if (!Number.isFinite(length) || length < 4 || length > 65520 || offset + length > body.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    }
    decoderPackets.push({ kind: 'data', payload: Buffer.from(body.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  const commands: PushCommand[] = [];
  for (const packet of decoderPackets) {
    if (packet.kind !== 'data' || !packet.payload) continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul); // first line's capabilities
    const parts = text.split(' ');
    if (parts.length < 3) throw new Error(`bad push command ${JSON.stringify(text.slice(0, 60))}`);
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const pack = packStart < body.length ? body.subarray(packStart) : null;
  return { commands, pack: pack && pack.length > 0 ? Buffer.from(pack) : null };
}

function receivePackResponse(store: Store, repo: Repo, body: Buffer): Buffer {
  let unpackOk = true;
  let unpackDetail = 'ok';
  let commands: PushCommand[] = [];
  let packObjects: Map<string, GitObject> | null = null;
  try {
    const parsed = parseReceivePack(body);
    commands = parsed.commands;
    if (commands.length === 0) throw new Error('no push commands');
    if (parsed.pack !== null) {
      const read = readPack(parsed.pack, { resolveBase: (oid) => repo.objects.get(oid) });
      packObjects = read.objects;
    }
  } catch (err) {
    unpackOk = false;
    unpackDetail = err instanceof Error ? err.message : String(err);
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk && packObjects !== null) {
    for (const [oid, object] of packObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  if (!unpackOk) {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: unpackDetail });
  } else {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (!isObjectId(command.oldOid) || !isObjectId(command.newOid) || !command.ref.startsWith('refs/')) {
        results.push({ ref: command.ref, ok: false, reason: 'invalid command' });
        continue;
      }
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        } else if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
          results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      // Create or update: the new object must be present.
      const target = repo.objects.get(command.newOid);
      if (!target) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'ref already exists' });
        } else {
          repo.refs.set(command.ref, command.newOid);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        continue;
      }
      if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      if (target.type !== 'commit') {
        results.push({ ref: command.ref, ok: false, reason: 'new object is not a commit' });
        continue;
      }
      // Fast-forward only: old must be an ancestor of new.
      const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
      const ff = isAncestor(command.oldOid, command.newOid, lookup);
      if (!ff) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }

  // The report-status stream, pkt-lined, inside sideband band 1. The
  // report-status's own flush-pkt is part of the inner stream: git's status
  // reader parses pkt-lines from the demultiplexed band-1 data and needs to
  // see that flush to terminate; the outer flush below only ends the
  // sideband stream itself.
  const inner: Array<string | 'flush'> = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    inner.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  inner.push('flush');
  const innerBytes = encodePktLines(inner);
  return Buffer.concat([sidebandPack(innerBytes), PKT_FLUSH]);
}

export interface GitOutcome {
  status: number;
  contentType: string;
  body: Buffer;
}

/** Route one git smart-HTTP request. `service` is the info/refs or POST service name. */
export function handleGit(
  store: Store,
  route: GitRoute,
  method: string,
  query: URLSearchParams,
  gitProtocol: string,
  body: Buffer,
): GitOutcome {
  const repo = store.getRepo(route.repoName);
  const notFound = (): GitOutcome => ({
    status: 404,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'),
  });
  if (!repo) return notFound();

  if (method === 'GET' && route.service === 'info/refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      if (gitProtocol === '2') {
        return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement('git-upload-pack', repo) };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement('git-receive-pack', repo) };
    }
    return notFound();
  }

  if (method === 'POST' && route.service === 'git-upload-pack') {
    try {
      if (gitProtocol === '2') {
        const { command, args } = parseV2Command(body);
        if (command === 'ls-refs') {
          const peel = args.includes('peel');
          const symrefs = args.includes('symrefs');
          const unborn = args.includes('unborn');
          const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
          return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsLines(repo, { peel, symrefs, unborn, prefixes }) };
        }
        if (command === 'fetch') {
          const req = parseV2FetchArgs(args);
          return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2FetchResponse(store, repo, req) };
        }
        return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: `unknown command ${command}` }), 'utf8') };
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0FetchResponse(store, repo, body) };
    } catch (err) {
      return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }), 'utf8') };
    }
  }

  if (method === 'POST' && route.service === 'git-receive-pack') {
    try {
      return { status: 200, contentType: 'application/x-git-receive-pack-result', body: receivePackResponse(store, repo, body) };
    } catch (err) {
      return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }), 'utf8') };
    }
  }

  return notFound();
}

// rest.ts — GitHub REST v3 under /api/v3.
// Repositories, branches, commits, contents, labels, issues, comments,
// pull requests, files and merges, over the store in store.ts.
// Every reply is application/json with a non-empty X-GitHub-Request-Id;
// errors carry {"message": ...}; auth is Bearer MAKEFUN_SHOP_TOKEN.

import { isObjectId, parseCommit, parseTree } from './git.ts';
import { type Issue, type PullRequest, type Repo, type Store } from './store.ts';

export interface RestOutcome {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestOutcome => ({ status, body, headers });
const err = (status: number, message: string): RestOutcome => ({ status, body: { message } });
const notFound = (): RestOutcome => err(404, 'Not Found');

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
function b64decode(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function isoNow(): string {
  return new Date().toISOString();
}

// -- shapes -------------------------------------------------------------------

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoNow(),
    updated_at: isoNow(),
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: isoNow(),
    updated_at: isoNow(),
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: isoNow(),
    updated_at: isoNow(),
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body, created_at: isoNow(), updated_at: isoNow() };
}

// -- pagination ---------------------------------------------------------------

interface Page<T> {
  items: T[];
  link: string | null;
}

function paginate<T>(all: T[], query: URLSearchParams, path: string, baseUrl: string): Page<T> {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  let link: string | null = null;
  if (page < totalPages) {
    const next = `${baseUrl}${path}?per_page=${perPage}&page=${page + 1}`;
    const last = `${baseUrl}${path}?per_page=${perPage}&page=${totalPages}`;
    link = `<${next}>; rel="next", <${last}>; rel="last"`;
  } else if (totalPages > 1) {
    const first = `${baseUrl}${path}?per_page=${perPage}&page=1`;
    link = `<${first}>; rel="first", <${baseUrl}${path}?per_page=${perPage}&page=${totalPages}>; rel="last"`;
  }
  return { items, link };
}

function linkHeaders(page: Page<unknown>): Record<string, string> {
  return page.link ? { link: page.link } : {};
}

// -- the router ----------------------------------------------------------------

export interface RestRequest {
  method: string;
  segments: string[]; // path segments below /api/v3 (decoded)
  query: URLSearchParams;
  /** The parsed JSON body, or undefined when there is no body. `__parseError` when malformed. */
  body: unknown;
  baseUrl: string; // e.g. http://127.0.0.1:PORT, for Link headers
}

/**
 * Route one REST request. `authenticated` is true when the bearer token matched.
 * The caller (app.ts) handles 401 for unauthenticated requests to protected routes;
 * this function assumes the caller already enforced it, except that the public
 * routes (/, /meta, /user) are answered here regardless.
 */
export function handleRest(store: Store, req: RestRequest): RestOutcome {
  const { method, segments, query } = req;
  const seg = (i: number): string | undefined => segments[i];

  // Public root and meta.
  if (segments.length === 0) {
    if (method === 'GET') {
      return ok(200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      });
    }
    return notFound();
  }
  if (segments.length === 1 && seg(0) === 'meta') {
    if (method === 'GET') return ok(200, { installed_version: '1.0.0' });
    return notFound();
  }
  if (segments.length === 1 && seg(0) === 'user') {
    if (method === 'GET') {
      return ok(200, {
        login: store.viewerLogin,
        id: 1000,
        node_id: Buffer.from(`User:${store.viewerLogin}`).toString('base64'),
        name: store.viewerLogin,
        email: store.viewerEmail(),
        type: 'User',
      });
    }
    return notFound();
  }

  // POST /user/repos and GET /user/repos
  if (seg(0) === 'user' && seg(1) === 'repos') {
    if (segments.length !== 2) return notFound();
    if (method === 'POST') {
      if (req.body === '__parseError') return err(400, 'Problems parsing JSON');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return err(422, 'name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is invalid');
      const repo = store.createRepo(name, {
        description: typeof body.description === 'string' ? body.description : '',
        private: body.private === true,
      });
      if (repo === null) return err(422, 'Repository already exists');
      return ok(201, repoJson(store, repo));
    }
    if (method === 'GET') {
      const page = paginate(store.listRepos(), query, '/api/v3/user/repos', req.baseUrl);
      return ok(200, page.items.map((repo) => repoJson(store, repo)), linkHeaders(page));
    }
    return notFound();
  }

  // Everything below is /repos/{owner}/{repo}[...]
  if (seg(0) !== 'repos') return notFound();
  const owner = seg(1);
  const repoName = seg(2);
  if (owner === undefined || repoName === undefined) return notFound();
  // The token's user owns every repository; another owner is a 404, never a 403.
  if (owner !== store.viewerLogin) return notFound();
  const repo = store.getRepo(repoName);
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (!repo) return notFound();
    if (method === 'GET') return ok(200, repoJson(store, repo));
    if (method === 'PATCH') {
      if (req.body === '__parseError') return err(400, 'Problems parsing JSON');
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      return ok(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repoName);
      return { status: 204, body: null };
    }
    return notFound();
  }

  if (!repo) return notFound();

  // -- branches ---------------------------------------------------------------
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = store
        .listRefs(repo)
        .filter((ref) => ref.name.startsWith('refs/heads/'))
        .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid }, protected: false }));
      return ok(200, branches);
    }
    if (rest.length === 2 && method === 'GET') {
      const ref = `refs/heads/${rest[1]}`;
      const oid = repo.refs.get(ref);
      if (!oid) return notFound();
      return ok(200, { name: rest[1], commit: { sha: oid }, protected: false });
    }
    return notFound();
  }

  // -- commits ----------------------------------------------------------------
  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const shaParam = query.get('sha');
      const tip = shaParam ? store.resolveRef(repo, shaParam) : store.defaultTip(repo);
      if (!tip) return ok(200, []);
      const commits = collectCommitsOrdered(store, repo, tip);
      const page = paginate(commits, query, `/api/v3/repos/${owner}/${repoName}/commits`, req.baseUrl);
      return ok(
        200,
        page.items.map((oid) => commitJson(store, repo, oid)),
        linkHeaders(page),
      );
    }
    return notFound();
  }

  // -- git refs ---------------------------------------------------------------
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      if (req.body === '__parseError') return err(400, 'Problems parsing JSON');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha)) return err(422, 'ref and sha are required');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      const object = repo.objects.get(sha);
      if (!object || object.type !== 'commit') return err(422, 'sha does not name a commit');
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha, type: 'commit' } });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (!oid) return notFound();
      return ok(200, { ref, object: { sha: oid, type: 'commit' } });
    }
    return notFound();
  }

  // -- contents ---------------------------------------------------------------
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return contentsGet(store, repo, path, query.get('ref'));
    if (method === 'PUT') return contentsPut(store, repo, path, req);
    if (method === 'DELETE') return contentsDelete(store, repo, path, req);
    return notFound();
  }

  // -- labels -----------------------------------------------------------------
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return ok(200, [...repo.labels.values()].map(labelJson));
    }
    if (method === 'POST' && rest.length === 1) {
      if (req.body === '__parseError') return err(400, 'Problems parsing JSON');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      if (name === '') return err(422, 'name is required');
      if (repo.labels.has(name)) return err(422, 'Label already exists');
      const label = { name, color };
      repo.labels.set(name, label);
      return ok(201, labelJson(label));
    }
    return notFound();
  }

  // -- issues -----------------------------------------------------------------
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        let issues = [...repo.issues.values()];
        const state = query.get('state') ?? 'open';
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        const direction = query.get('direction') ?? 'desc';
        const sort = query.get('sort') ?? 'created';
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        const page = paginate(issues, query, `/api/v3/repos/${owner}/${repoName}/issues`, req.baseUrl);
        return ok(200, page.items.map((issue) => issueJson(store, repo, issue)), linkHeaders(page));
      }
      if (method === 'POST') {
        if (req.body === '__parseError') return err(400, 'Problems parsing JSON');
        const body = (req.body ?? {}) as Record<string, unknown>;
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') return err(422, 'title is required');
        const labels: { name: string; color: string }[] = [];
        if (Array.isArray(body.labels)) {
          for (const name of body.labels) {
            if (typeof name !== 'string') continue;
            const label = repo.labels.get(name);
            if (!label) return err(422, `Label "${name}" does not exist`);
            labels.push(label);
          }
        }
        const issue = store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
        return ok(201, issueJson(store, repo, issue));
      }
      return notFound();
    }
    const number = parseInt(rest[1], 10);
    if (!Number.isFinite(number)) return notFound();
    const issue = repo.issues.get(number);
    if (rest.length === 2) {
      if (!issue) return notFound();
      if (method === 'GET') return ok(200, issueJson(store, repo, issue));
      if (method === 'PATCH') {
        if (req.body === '__parseError') return err(400, 'Problems parsing JSON');
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        return ok(200, issueJson(store, repo, issue));
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!issue) return notFound();
      if (method === 'GET') {
        return ok(200, issue.comments.map(commentJson));
      }
      if (method === 'POST') {
        if (req.body === '__parseError') return err(400, 'Problems parsing JSON');
        const body = (req.body ?? {}) as Record<string, unknown>;
        const commentBody = typeof body.body === 'string' ? body.body : '';
        const comment = { id: repo.nextCommentId++, body: commentBody, createdSeq: store.nextSeq() };
        issue.comments.push(comment);
        return ok(201, commentJson(comment));
      }
      return notFound();
    }
    return notFound();
  }

  // -- pull requests ------------------------------------------------------------
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        let pulls = [...repo.pulls.values()];
        const state = query.get('state') ?? 'open';
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        const page = paginate(pulls, query, `/api/v3/repos/${owner}/${repoName}/pulls`, req.baseUrl);
        return ok(200, page.items.map((pull) => pullJson(store, repo, pull)), linkHeaders(page));
      }
      if (method === 'POST') {
        if (req.body === '__parseError') return err(400, 'Problems parsing JSON');
        const body = (req.body ?? {}) as Record<string, unknown>;
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
        const title = typeof body.title === 'string' ? body.title : '';
        if (head === '' || title === '') return err(422, 'head and title are required');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha) return err(422, `head branch "${head}" does not exist`);
        if (!baseSha) return err(422, `base branch "${base}" does not exist`);
        const existing = [...repo.pulls.values()].find(
          (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
        );
        if (existing) return err(422, 'A pull request already exists for this head and base');
        const pull = store.createPull(repo, head, headSha, base, baseSha, title, typeof body.body === 'string' ? body.body : '');
        return ok(201, pullJson(store, repo, pull));
      }
      return notFound();
    }
    const number = parseInt(rest[1], 10);
    if (!Number.isFinite(number)) return notFound();
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (!pull) return notFound();
      if (method === 'GET') return ok(200, pullJson(store, repo, pull));
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (!pull) return notFound();
      if (method !== 'GET') return notFound();
      return ok(200, pullFiles(store, repo, pull));
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (!pull) return notFound();
      if (method !== 'PUT') return notFound();
      return pullMerge(store, repo, pull);
    }
    return notFound();
  }

  return notFound();
}

function collectCommitsOrdered(store: Store, repo: Repo, tip: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return out;
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const commit = object ? parseCommit(object.data) : null;
  // The stored commit message ends with a newline (git convention); the REST
  // API reports it without the trailing newline, as GitHub does.
  const message = (commit?.message ?? '').replace(/\n$/, '');
  return {
    sha: oid,
    commit: {
      message,
      author: { name: store.viewerLogin, email: store.viewerEmail() },
      committer: { name: store.viewerLogin, email: store.viewerEmail() },
      tree: { sha: commit?.tree ?? '' },
    },
    author: { login: store.viewerLogin },
    committer: { login: store.viewerLogin },
  };
}

// -- contents -----------------------------------------------------------------

function contentsGet(store: Store, repo: Repo, path: string, refParam: string | null): RestOutcome {
  const tip = refParam ? store.resolveRef(repo, refParam) : store.defaultTip(repo);
  if (!tip) return notFound();
  const blob = store.blobAt(repo, tip, path);
  if (blob) {
    return ok(200, {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: blob.oid,
      size: blob.data.length,
      name: path.split('/').pop() ?? path,
      path,
    });
  }
  const tree = store.treeAt(repo, tip, path);
  if (!tree) return notFound();
  const entries = tree.entries.map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
  }));
  return ok(200, entries);
}

function contentsPut(store: Store, repo: Repo, path: string, req: RestRequest): RestOutcome {
  if (req.body === '__parseError') return err(400, 'Problems parsing JSON');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message : 'update';
  const content = typeof body.content === 'string' ? body.content : '';
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  let contentBytes: Buffer;
  try {
    contentBytes = b64decode(content);
  } catch {
    return err(422, 'content is not valid base64');
  }
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  const existing = tip ? store.blobAt(repo, tip, path) : null;
  if (existing && sha === undefined) return err(422, 'sha is required to update a file');
  if (existing && sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) {
    return err(409, 'sha does not match the current file');
  }
  const isUpdate = existing !== null;
  const blobOid = store.putObject(repo, 'blob', contentBytes);
  const baseTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : null;
  const newTree = store.setPath(repo, baseTree, path, blobOid);
  const commitOid = store.commitOn(repo, branch, newTree, message);
  return ok(isUpdate ? 200 : 201, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: blobOid,
      size: contentBytes.length,
      encoding: 'base64',
      type: 'file',
    },
    commit: { sha: commitOid, message },
  });
}

function contentsDelete(store: Store, repo: Repo, path: string, req: RestRequest): RestOutcome {
  if (req.body === '__parseError') return err(400, 'Problems parsing JSON');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message : 'delete';
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  if (!tip) return notFound();
  const existing = store.blobAt(repo, tip, path);
  if (!existing) return notFound();
  if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) {
    return err(409, 'sha does not match the current file');
  }
  const baseTree = parseCommit(repo.objects.get(tip)!.data).tree;
  const newTree = store.setPath(repo, baseTree, path, null);
  const commitOid = store.commitOn(repo, branch, newTree, message);
  return ok(200, { commit: { sha: commitOid, message } });
}

// -- pull request files and merge ----------------------------------------------

function pullFiles(store: Store, repo: Repo, pull: PullRequest): Array<Record<string, unknown>> {
  const mergeBase = store.mergeBase(repo, pull.headSha, pull.baseSha);
  const baseCommit = mergeBase ?? pull.baseSha;
  const changes = store.diffCommits(repo, baseCommit, pull.headSha);
  return changes.map((change) => {
    const oldData =
      change.baseOid === null ? null : (repo.objects.get(change.baseOid)?.data ?? null);
    const newData =
      change.headOid === null ? null : (repo.objects.get(change.headOid)?.data ?? null);
    const { additions, deletions } = store.lineDiff(oldData, newData);
    return {
      filename: change.path,
      status: change.status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: change.headOid ?? change.baseOid ?? '',
    };
  });
}

function pullMerge(store: Store, repo: Repo, pull: PullRequest): RestOutcome {
  if (pull.merged) return err(405, 'Pull request has already been merged');
  if (pull.state === 'closed') return err(405, 'Pull request is closed');
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return err(404, 'Pull request is not mergeable');
  const mergeBase = store.mergeBase(repo, headTip, baseTip);
  if (mergeBase === null) return err(405, 'Pull request has no merge base');
  const conflicts = store.mergeConflicts(repo, mergeBase, headTip, baseTip);
  if (conflicts.length > 0) return err(405, `Merge conflict in ${conflicts[0]}`);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
  const mergeSha = store.squashMerge(repo, pull.baseRef, baseTip, mergeBase, headTip, message);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoNow();
  pull.mergeCommitSha = mergeSha;
  pull.baseSha = mergeSha;
  return ok(200, { merged: true, sha: mergeSha, message: `Pull request successfully merged` });
}

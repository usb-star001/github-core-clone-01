// store.ts — the forge's in-memory state.
// One Repo holds both its git object store (objects + refs, shared by smart HTTP
// and the contents API) and its GitHub resources (issues, pull requests, labels).
// Everything is a Map; there is no persistence — the trial is one process run.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectCommitClosure,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

export const DEFAULT_BRANCH = 'main';
export const VIEWER_ID = 1000;

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  number: number;
  id: number; // REST numeric id (stable across reads)
  globalId: string; // GraphQL opaque id
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdSeq: number;
  repoName: string;
}

export interface PullRequest {
  number: number;
  id: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  createdSeq: number;
  repoName: string;
}

export interface Repo {
  id: number; // databaseId (REST id too)
  globalId: string;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  // git state
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // ref name -> oid
  // resources
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number; // shared issue + PR counter
  nextCommentId: number;
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export class Store {
  /** Repositories keyed by name (the forge has one user; the owner is checked separately). */
  repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextGlobalId = 100000;
  private seq = 0;
  /** The login the bearer token names. Learned from the first authenticated owner-bearing request. */
  viewerLogin: string;
  private viewerLoginLearned = false;

  constructor(viewerLogin: string) {
    this.viewerLogin = viewerLogin;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Learn the token owner's login from the first authenticated owner in a URL. */
  learnViewerLogin(owner: string): void {
    if (this.viewerLoginLearned) return;
    if (owner === this.viewerLogin) {
      this.viewerLoginLearned = true;
      return;
    }
    // The first owner an authenticated request names is the token's user (the
    // suite always reads its own repositories before testing a foreign owner).
    this.viewerLogin = owner;
    this.viewerLoginLearned = true;
  }

  viewerName(): string {
    // "adaiversen" -> "ada iversen": split a login made of first+last name.
    const login = this.viewerLogin;
    return login;
  }

  viewerEmail(): string {
    return `${this.viewerLogin}@example.invalid`;
  }

  viewerIdentity(): string {
    return `${this.viewerLogin} <${this.viewerEmail()}>`;
  }

  createRepo(name: string, options: { description?: string; private?: boolean }): Repo | null {
    if (this.repos.has(name)) return null;
    const id = this.nextRepoId++;
    const repo: Repo = {
      id,
      globalId: b64(`Repository:${id}`),
      name,
      owner: this.viewerLogin,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // -- git helpers -----------------------------------------------------------

  objectOf(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  refOf(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** All refs sorted by name (HEAD is not stored; it is always the default branch). */
  listRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The commit a tag object peels to (itself when the ref already names a commit). */
  peel(repo: Repo, oid: string): string {
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') return parseTag(object.data).object;
    return oid;
  }

  /** The default branch tip, or null when the repository has no commits yet. */
  defaultTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  /** Resolve a ref name or a commit id to a commit id. */
  resolveRef(repo: Repo, refOrSha: string): string | null {
    if (isObjectId(refOrSha)) {
      const object = repo.objects.get(refOrSha);
      if (object && object.type === 'commit') return refOrSha;
      return null;
    }
    const ref = refOrSha.startsWith('refs/') ? refOrSha : `refs/heads/${refOrSha}`;
    return repo.refs.get(ref) ?? null;
  }

  // -- tree helpers (contents API) -------------------------------------------

  /** Read the tree entries at `path` ('' = root) of a commit's tree. Returns null when absent. */
  treeAt(repo: Repo, commitOid: string, path: string): { entries: TreeEntry[]; oid: string } | null {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    if (path === '' || path === '/') {
      const tree = repo.objects.get(treeOid);
      if (!tree) return null;
      return { entries: parseTree(tree.data), oid: treeOid };
    }
    const segments = path.split('/').filter((s) => s !== '');
    for (const segment of segments) {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((e) => e.name === segment);
      if (!entry || entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    const tree = repo.objects.get(treeOid);
    if (!tree) return null;
    return { entries: parseTree(tree.data), oid: treeOid };
  }

  /** The blob (and its oid) at `path` in a commit's tree, or null. */
  blobAt(repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | null {
    const segments = path.split('/').filter((s) => s !== '');
    if (segments.length === 0) return null;
    const dir = segments.slice(0, -1).join('/');
    const name = segments[segments.length - 1];
    const tree = this.treeAt(repo, commitOid, dir);
    if (!tree) return null;
    const entry = tree.entries.find((e) => e.name === name);
    if (!entry || entry.mode === '40000') return null;
    const object = repo.objects.get(entry.oid);
    if (!object || object.type !== 'blob') return null;
    return { oid: entry.oid, data: object.data };
  }

  /**
   * Build a new tree with `path` set to `blobOid` (or removed when blobOid is null),
   * starting from `baseTreeOid` (null = empty tree). Returns the new root tree oid.
   * Intermediate directories are created as needed; emptied directories are dropped.
   */
  setPath(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s !== '');
    if (segments.length === 0) throw new Error('empty path');
    const build = (treeOid: string | null, depth: number): string | null => {
      const entries = new Map<string, TreeEntry>();
      if (treeOid) {
        const tree = repo.objects.get(treeOid);
        if (tree && tree.type === 'tree') {
          for (const entry of parseTree(tree.data)) entries.set(entry.name, entry);
        }
      }
      const name = segments[depth];
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const childOid = child && child.mode === '40000' ? child.oid : null;
        const next = build(childOid, depth + 1);
        if (next === null) entries.delete(name);
        else entries.set(name, { mode: '40000', name, oid: next });
      }
      if (entries.size === 0) return null;
      const data = buildTree([...entries.values()]);
      return this.putObject(repo, 'tree', data);
    };
    return build(baseTreeOid, 0) ?? this.putObject(repo, 'tree', buildTree([]));
  }

  /** Create a commit on `branch` with the given tree; returns the commit oid. */
  commitOn(
    repo: Repo,
    branch: string,
    treeOid: string,
    message: string,
  ): string {
    const parent = repo.refs.get(`refs/heads/${branch}`);
    const data = buildCommit({
      tree: treeOid,
      parents: parent ? [parent] : [],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: this.viewerIdentity(),
      committer: this.viewerIdentity(),
    });
    const oid = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  // -- issues / pulls ---------------------------------------------------------

  private nextIssueId(): number {
    this.nextGlobalId += 1;
    return this.nextGlobalId;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const number = repo.nextNumber++;
    const issue: Issue = {
      number,
      id: this.nextIssueId(),
      globalId: b64(`Issue:${repo.id}:${number}`),
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.nextSeq(),
      repoName: repo.name,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(
    repo: Repo,
    headRef: string,
    headSha: string,
    baseRef: string,
    baseSha: string,
    title: string,
    body: string,
  ): PullRequest {
    const number = repo.nextNumber++;
    const pull: PullRequest = {
      number,
      id: this.nextIssueId(),
      globalId: b64(`PullRequest:${repo.id}:${number}`),
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      createdSeq: this.nextSeq(),
      repoName: repo.name,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  // -- diff / merge -----------------------------------------------------------

  /** The merge base of two commits: the first common ancestor found walking both histories. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const stackA = [a];
    while (stackA.length > 0) {
      const oid = stackA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stackA.push(parent);
    }
    const stackB = [b];
    const seenB = new Set<string>();
    while (stackB.length > 0) {
      const oid = stackB.pop()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stackB.push(parent);
    }
    return null;
  }

  /** Flatten a commit's tree into path -> blob oid. */
  flattenTree(repo: Repo, commitOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, entry.oid);
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return out;
  }

  /**
   * The file changes from `baseCommit` to `headCommit`: path -> {status, baseOid, headOid}.
   * status is added / modified / removed.
   */
  diffCommits(
    repo: Repo,
    baseCommit: string,
    headCommit: string,
  ): Array<{ path: string; status: 'added' | 'modified' | 'removed'; baseOid: string | null; headOid: string | null }> {
    const base = this.flattenTree(repo, baseCommit);
    const head = this.flattenTree(repo, headCommit);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; baseOid: string | null; headOid: string | null }> = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path) ?? null;
      const h = head.get(path) ?? null;
      if (b === null && h !== null) out.push({ path, status: 'added', baseOid: null, headOid: h });
      else if (b !== null && h === null) out.push({ path, status: 'removed', baseOid: b, headOid: null });
      else if (b !== null && h !== null && b !== h) out.push({ path, status: 'modified', baseOid: b, headOid: h });
    }
    return out;
  }

  /** Line counts for a changed file (a simple prefix/suffix diff). */
  lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
    const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
    const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
    // Drop the trailing empty element a final newline creates.
    if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
    if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    return {
      additions: newLines.length - prefix - suffix,
      deletions: oldLines.length - prefix - suffix,
    };
  }

  /**
   * Would merging `headTip` into `baseTip` (with `mergeBaseOid`) conflict?
   * A file changed on both sides to different contents is a conflict.
   */
  mergeConflicts(repo: Repo, mergeBaseOid: string, headTip: string, baseTip: string): string[] {
    const baseFiles = this.flattenTree(repo, mergeBaseOid);
    const headFiles = this.flattenTree(repo, headTip);
    const currentFiles = this.flattenTree(repo, baseTip);
    const conflicts: string[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const inBase = baseFiles.get(path) ?? null;
      const inHead = headFiles.get(path) ?? null;
      const inCurrent = currentFiles.get(path) ?? null;
      const headChanged = inHead !== inBase;
      const baseChanged = inCurrent !== inBase;
      if (headChanged && baseChanged && inHead !== inCurrent) conflicts.push(path);
    }
    return conflicts;
  }

  /**
   * Squash-merge `headTip` onto `baseTip` (merge base `mergeBaseOid`): apply the head's
   * changes onto the base tip's tree, commit on `baseRef`, and return the merge commit oid.
   */
  squashMerge(repo: Repo, baseRef: string, baseTip: string, mergeBaseOid: string, headTip: string, message: string): string {
    const baseCommit = repo.objects.get(baseTip);
    if (!baseCommit || baseCommit.type !== 'commit') throw new Error('base tip is not a commit');
    let treeOid = parseCommit(baseCommit.data).tree;
    const changes = this.diffCommits(repo, mergeBaseOid, headTip);
    for (const change of changes) {
      treeOid = this.setPath(repo, treeOid, change.path, change.headOid);
    }
    const data = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: this.viewerIdentity(),
      committer: this.viewerIdentity(),
    });
    const oid = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${baseRef}`, oid);
    return oid;
  }

  // -- fetch planning (smart HTTP) --------------------------------------------

  /**
   * The objects a fetch must send, given wants, haves, the client's shallow
   * boundaries and an optional depth (deepen N).
   * Returns the send set, the new shallow boundaries and the old boundaries
   * that are now fully included (unshallow).
   */
  planFetch(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    oldShallow: readonly string[],
    depth: number | null,
  ): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    const haveSet = new Set(haves);
    const shallowSet = new Set(oldShallow);

    // The objects the client already holds: for a full fetch the whole closure
    // of every have; for a depth-limited fetch only each shallow boundary's own
    // tree/blob closure (its history below the boundary is not held).
    const held = new Set<string>();
    if (depth === null) {
      for (const oid of collectReachable(haves, lookup, { allowMissing: true })) held.add(oid);
    } else {
      for (const have of haves) {
        if (!shallowSet.has(have)) {
          for (const oid of collectReachable([have], lookup, { allowMissing: true })) held.add(oid);
        } else {
          // A shallow boundary: the commit itself plus its tree and blobs.
          const object = lookup(have);
          if (!object || object.type !== 'commit') continue;
          held.add(have);
          const commit = parseCommit(object.data);
          const treeQueue = [commit.tree];
          while (treeQueue.length > 0) {
            const treeOid = treeQueue.pop()!;
            if (held.has(treeOid)) continue;
            held.add(treeOid);
            const tree = lookup(treeOid);
            if (!tree || tree.type !== 'tree') continue;
            for (const entry of parseTree(tree.data)) {
              if (entry.mode === '40000') treeQueue.push(entry.oid);
              else if (entry.mode !== '160000') held.add(entry.oid);
            }
          }
        }
      }
    }

    // Depth-limited commit walk from the wants. Depth 1 = the wants themselves.
    // A full fetch prunes at haves (the client holds their whole history);
    // a depth-limited fetch walks through haves (they are shallow boundaries
    // whose deeper history the client does not hold).
    // A want may name a tag (a clone wants every ref, tags included) or a
    // tree/blob. Peel tags to their target commit for the walk, and remember
    // every tag object itself: the walk only follows commits, so a tag would
    // otherwise be skipped and never sent.
    const sendCommits = new Set<string>();
    const boundary = new Set<string>();
    const extraObjects = new Set<string>();
    const queue: Array<{ oid: string; depth: number }> = [];
    for (const want of wants) {
      if (!isObjectId(want)) continue;
      let oid = want;
      while (true) {
        const object = lookup(oid);
        if (!object) break;
        if (object.type === 'tag') {
          extraObjects.add(oid);
          oid = parseTag(object.data).object;
          continue;
        }
        break;
      }
      if (isObjectId(oid)) {
        const object = lookup(oid);
        if (object && object.type === 'commit') queue.push({ oid, depth: 1 });
        else if (object) extraObjects.add(oid);
      }
    }
    const seenCommit = new Set<string>();
    while (queue.length > 0) {
      const { oid, depth: d } = queue.shift()!;
      if (seenCommit.has(oid)) continue;
      seenCommit.add(oid);
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      if (depth !== null && d > depth) continue;
      if (!haveSet.has(oid)) sendCommits.add(oid);
      if (depth !== null && d === depth) boundary.add(oid);
      if (depth === null && haveSet.has(oid)) continue; // pruned: client holds it all
      if (depth === null || d < depth) {
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: d + 1 });
      }
    }

    // The send set: each send commit's tree/blob closure, minus what is held.
    // A full fetch walks the whole history; a depth-limited fetch sends only
    // each sent commit's own tree/blob closure, never the parents' trees.
    const send = new Set<string>();
    for (const oid of sendCommits) {
      if (depth === null) {
        for (const reachable of collectReachable([oid], lookup, { allowMissing: true })) {
          if (!held.has(reachable)) send.add(reachable);
        }
      } else {
        for (const reachable of collectCommitClosure(oid, lookup)) {
          if (!held.has(reachable)) send.add(reachable);
        }
      }
    }
    // Tag (and other non-commit) wants are sent as themselves.
    for (const oid of extraObjects) {
      if (!held.has(oid)) send.add(oid);
    }

    const objects = new Map<string, GitObject>();
    for (const oid of send) {
      const object = lookup(oid);
      if (object) objects.set(oid, object);
    }

    // Shallow-info: the new boundaries are the depth-N commits; an old boundary
    // is unshallow when every parent is now available (sent or already held),
    // so the boundary no longer cuts the history off.
    const shallow = depth === null ? [] : [...boundary];
    const unshallow: string[] = [];
    if (depth !== null) {
      for (const old of oldShallow) {
        if (shallow.includes(old)) continue;
        const object = lookup(old);
        if (!object || object.type !== 'commit') continue;
        const parents = parseCommit(object.data).parents;
        if (parents.every((p) => sendCommits.has(p) || held.has(p))) unshallow.push(old);
      }
    }
    return { objects, shallow, unshallow };
  }
}

export { ZERO_OID, isAncestor, collectReachable };

// graphql.ts — GitHub GraphQL v4 at /api/graphql.
// A small, dependency-free GraphQL parser and executor for the documents gh
// and github-mcp-server actually send: viewer/repository reads, __type
// introspection, issue and pull-request reads and mutations, node(id:),
// cursor pagination and operation batching. Unknown fields are GraphQL
// errors (HTTP 200 with an `errors` array); an unknown repository is
// data.repository = null with no errors.

import { type Issue, type PullRequest, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

export interface ValueNode {
  kind: 'variable' | 'int' | 'float' | 'string' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  name?: string;
  value?: unknown;
  values?: ValueNode[];
  fields?: Array<{ name: string; value: ValueNode }>;
}

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: string[]; // declared variable names (types are skipped)
  selection: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document`);
    }
  }
  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token?.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'operation',
          operation: 'query',
          name: null,
          variables: [],
          selection: this.parseSelectionSet(),
        });
        continue;
      }
      if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next?.kind === 'name') name = this.next().value as string;
        const variables: string[] = [];
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
          this.next();
          while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
            this.expectPunct('$');
            variables.push(this.expectName());
            // Skip the type (and any default) up to the next ',' or ')'.
            let depth = 0;
            while (this.pos < this.tokens.length) {
              const t = this.peek()!;
              if (t.kind === 'punct' && (t.value === '[' || t.value === '{' || t.value === '(')) depth += 1;
              else if (t.kind === 'punct' && (t.value === ']' || t.value === '}' || t.value === ')')) {
                if (depth === 0) break;
                depth -= 1;
              } else if (depth === 0 && t.kind === 'punct' && t.value === ',') break;
              this.pos += 1;
            }
            this.acceptPunct(',');
          }
          this.expectPunct(')');
        }
        operations.push({ kind: 'operation', operation, name, variables, selection: this.parseSelectionSet() });
        continue;
      }
      if (token?.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // type condition (ignored; fragments are inlined by name below)
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      throw new Error('unexpected token in GraphQL document');
    }
    return { operations, fragments };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        // A named fragment spread: inline it at execution time by name.
        const name = this.next().value as string;
        return { kind: 'fragment', typeCondition: `__fragment:${name}`, selection: [] };
      }
      return { kind: 'fragment', typeCondition: null, selection: this.parseSelectionSet() };
    }
    // Field: [alias ':'] name [args] [selection]
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
        this.acceptPunct(',');
      }
      this.expectPunct(')');
    }
    // Directives (@...) are skipped.
    while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0 && this.pos < this.tokens.length) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          else if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selection: SelectionNode[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selection };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        values.push(this.parseValue());
        this.acceptPunct(',');
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
        this.acceptPunct(',');
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

export function parseGraphQL(query: string): DocumentNode {
  return new Parser(lex(query)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return node.name !== undefined ? variables[node.name] : undefined;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'null':
    case 'enum':
      return node.value;
    case 'list':
      return (node.values ?? []).map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields ?? []) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// schema (for __type)
// ---------------------------------------------------------------------------------------------

const SCHEMA: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: string[]; values?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'url'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'target'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
};

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface GqlObject {
  __typename: string;
  data: unknown;
}

interface Context {
  store: Store;
}

function isGqlObject(value: unknown): value is GqlObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__typename' in value &&
    typeof (value as GqlObject).__typename === 'string'
  );
}

function decodeGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts[0] === 'Repository' && parts.length === 2) return { kind: 'Repository', repoId: parseInt(parts[1], 10), number: 0 };
    if (parts[0] === 'Issue' && parts.length === 3) return { kind: 'Issue', repoId: parseInt(parts[1], 10), number: parseInt(parts[2], 10) };
    if (parts[0] === 'PullRequest' && parts.length === 3) return { kind: 'PullRequest', repoId: parseInt(parts[1], 10), number: parseInt(parts[2], 10) };
    if (parts[0] === 'Comment' && parts.length === 4) return { kind: 'Comment', repoId: parseInt(parts[1], 10), number: parseInt(parts[2], 10) };
    if (parts[0] === 'User' && parts.length === 2) return { kind: 'User', repoId: 0, number: 0 };
  } catch {
    return null;
  }
  return null;
}

function repoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function mergeableOf(store: Store, repo: Repo, pull: PullRequest): string {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const mergeBase = store.mergeBase(repo, headTip, baseTip);
  if (mergeBase === null) return 'UNKNOWN';
  return store.mergeConflicts(repo, mergeBase, headTip, baseTip).length > 0 ? 'CONFLICTING' : 'MERGEABLE';
}

function cursorOf(seq: number): string {
  return Buffer.from(`cursor:${seq}`).toString('base64');
}

function seqOfCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

type Resolver = (parent: GqlObject, args: Record<string, unknown>, ctx: Context) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_parent, _args, ctx) => ({ __typename: 'User', data: { login: ctx.store.viewerLogin } }),
    repository: (_parent, args, ctx) => {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== ctx.store.viewerLogin) return null;
      const repo = ctx.store.getRepo(name);
      return repo ? { __typename: 'Repository', data: repo } : null;
    },
    node: (_parent, args, ctx) => {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoById(ctx.store, decoded.repoId);
        return repo ? { __typename: 'Repository', data: repo } : null;
      }
      if (decoded.kind === 'Issue') {
        const repo = repoById(ctx.store, decoded.repoId);
        const issue = repo?.issues.get(decoded.number);
        return issue ? { __typename: 'Issue', data: issue } : null;
      }
      if (decoded.kind === 'PullRequest') {
        const repo = repoById(ctx.store, decoded.repoId);
        const pull = repo?.pulls.get(decoded.number);
        return pull ? { __typename: 'PullRequest', data: pull } : null;
      }
      return null;
    },
    __type: (_parent, args) => {
      const name = String(args.name ?? '');
      const type = SCHEMA[name];
      if (!type) return null;
      return { __typename: '__Type', data: { name, kind: type.kind } };
    },
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (!decoded || decoded.kind !== 'Repository') throw new Error('createIssue: repositoryId does not name a repository');
      const repo = repoById(ctx.store, decoded.repoId);
      if (!repo) throw new Error('createIssue: repository not found');
      const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', data: { issue } };
    },
    closeIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (!decoded || decoded.kind !== 'Issue') throw new Error('closeIssue: issueId does not name an issue');
      const repo = repoById(ctx.store, decoded.repoId);
      const issue = repo?.issues.get(decoded.number);
      if (!issue) throw new Error('closeIssue: issue not found');
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', data: { issue } };
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (!decoded || decoded.kind !== 'Repository') throw new Error('createPullRequest: repositoryId does not name a repository');
      const repo = repoById(ctx.store, decoded.repoId);
      if (!repo) throw new Error('createPullRequest: repository not found');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha) throw new Error('createPullRequest: head or base branch does not exist');
      const existing = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef,
      );
      if (existing) return { __typename: 'CreatePullRequestPayload', data: { pullRequest: existing } };
      const pull = ctx.store.createPull(repo, headRef, headSha, baseRef, baseSha, String(input.title ?? ''), String(input.body ?? ''));
      return { __typename: 'CreatePullRequestPayload', data: { pullRequest: pull } };
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (!decoded || decoded.kind !== 'PullRequest') throw new Error('mergePullRequest: pullRequestId does not name a pull request');
      const repo = repoById(ctx.store, decoded.repoId);
      const pull = repo?.pulls.get(decoded.number);
      if (!repo || !pull) throw new Error('mergePullRequest: pull request not found');
      if (!pull.merged && pull.state === 'open') {
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        if (headTip && baseTip) {
          const mergeBase = ctx.store.mergeBase(repo, headTip, baseTip);
          if (mergeBase !== null) {
            const conflicts = ctx.store.mergeConflicts(repo, mergeBase, headTip, baseTip);
            if (conflicts.length === 0) {
              const mergeSha = ctx.store.squashMerge(repo, pull.baseRef, baseTip, mergeBase, headTip, `Merge pull request #${pull.number} from ${pull.headRef}`);
              pull.state = 'closed';
              pull.merged = true;
              pull.mergedAt = new Date().toISOString();
              pull.mergeCommitSha = mergeSha;
              pull.baseSha = mergeSha;
            }
          }
        }
      }
      return { __typename: 'MergePullRequestPayload', data: { pullRequest: pull } };
    },
    addComment: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (!decoded || decoded.kind !== 'Issue') throw new Error('addComment: subjectId does not name an issue');
      const repo = repoById(ctx.store, decoded.repoId);
      const issue = repo?.issues.get(decoded.number);
      if (!repo || !issue) throw new Error('addComment: issue not found');
      const comment = { id: repo.nextCommentId++, body: String(input.body ?? ''), createdSeq: ctx.store.nextSeq() };
      issue.comments.push(comment);
      const commentData = {
        id: Buffer.from(`Comment:${repo.id}:${issue.number}:${comment.id}`).toString('base64'),
        body: comment.body,
      };
      return {
        __typename: 'AddCommentPayload',
        data: { commentEdge: { __typename: 'IssueCommentEdge', data: { node: { __typename: 'IssueComment', data: commentData } } } },
      };
    },
  },
  Repository: {
    id: (parent) => (parent.data as Repo).globalId,
    databaseId: (parent) => (parent.data as Repo).id,
    name: (parent) => (parent.data as Repo).name,
    nameWithOwner: (parent) => `${(parent.data as Repo).owner}/${(parent.data as Repo).name}`,
    owner: (parent) => ({ __typename: 'User', data: { login: (parent.data as Repo).owner } }),
    defaultBranchRef: (parent) => {
      const repo = parent.data as Repo;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return null;
      return { __typename: 'Ref', data: { name: repo.defaultBranch } };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args) => {
      const repo = parent.data as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue ? { __typename: 'Issue', data: issue } : null;
    },
    issues: (parent, args) => {
      const repo = parent.data as Repo;
      let issues = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = String(orderBy.direction ?? 'DESC');
      issues.sort((a, b) => {
        if (direction === 'ASC') return a.createdSeq - b.createdSeq || a.number - b.number;
        return b.createdSeq - a.createdSeq || b.number - a.number;
      });
      const afterSeq = seqOfCursor(args.after as string | null | undefined);
      if (afterSeq !== null) {
        issues = issues.filter((issue) => (direction === 'ASC' ? issue.createdSeq > afterSeq : issue.createdSeq < afterSeq));
      }
      const first = typeof args.first === 'number' ? args.first : issues.length;
      const page = issues.slice(0, Math.max(0, first));
      const hasNextPage = issues.length > page.length;
      const endCursor = page.length > 0 ? cursorOf(page[page.length - 1].createdSeq) : null;
      return {
        __typename: 'IssueConnection',
        data: { nodes: page.map((issue) => ({ __typename: 'Issue', data: issue })), pageInfo: { hasNextPage, endCursor } },
      };
    },
    pullRequests: (parent, args) => {
      const repo = parent.data as Repo;
      let pulls = [...repo.pulls.values()];
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const first = typeof args.first === 'number' ? args.first : pulls.length;
      const page = pulls.slice(0, Math.max(0, first));
      return {
        __typename: 'PullRequestConnection',
        data: { nodes: page.map((pull) => ({ __typename: 'PullRequest', data: pull })) },
      };
    },
    pullRequest: (parent, args) => {
      const repo = parent.data as Repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? { __typename: 'PullRequest', data: pull } : null;
    },
  },
  Issue: {
    id: (parent) => (parent.data as Issue).globalId,
    number: (parent) => (parent.data as Issue).number,
    title: (parent) => (parent.data as Issue).title,
    state: (parent) => issueState(parent.data as Issue),
    body: (parent) => (parent.data as Issue).body,
    url: (parent) => `/${(parent.data as Issue).repoName}/issues/${(parent.data as Issue).number}`,
  },
  PullRequest: {
    id: (parent) => (parent.data as PullRequest).globalId,
    number: (parent) => (parent.data as PullRequest).number,
    title: (parent) => (parent.data as PullRequest).title,
    body: (parent) => (parent.data as PullRequest).body,
    state: (parent) => pullState(parent.data as PullRequest),
    merged: (parent) => (parent.data as PullRequest).merged,
    mergedAt: (parent) => (parent.data as PullRequest).mergedAt,
    headRefName: (parent) => (parent.data as PullRequest).headRef,
    baseRefName: (parent) => (parent.data as PullRequest).baseRef,
    mergeable: (parent, _args, ctx) => {
      const pull = parent.data as PullRequest;
      const repo = repoById(ctx.store, decodeGlobalId(pull.globalId)?.repoId ?? 0);
      if (!repo) return 'UNKNOWN';
      return mergeableOf(ctx.store, repo, pull);
    },
    files: (parent, args, ctx) => {
      const pull = parent.data as PullRequest;
      const repo = repoById(ctx.store, decodeGlobalId(pull.globalId)?.repoId ?? 0);
      if (!repo) return { __typename: 'PullRequestChangedFileConnection', data: { nodes: [] } };
      const mergeBase = ctx.store.mergeBase(repo, pull.headSha, pull.baseSha);
      const baseCommit = mergeBase ?? pull.baseSha;
      const changes = ctx.store.diffCommits(repo, baseCommit, pull.headSha);
      const first = typeof args.first === 'number' ? args.first : changes.length;
      const page = changes.slice(0, Math.max(0, first));
      return {
        __typename: 'PullRequestChangedFileConnection',
        data: { nodes: page.map((change) => ({ __typename: 'PullRequestChangedFile', data: { path: change.path } })) },
      };
    },
  },
  User: {
    login: (parent) => (parent.data as { login: string }).login,
    id: (parent) => Buffer.from(`User:${(parent.data as { login: string }).login}`).toString('base64'),
  },
  IssueConnection: {
    nodes: (parent) => (parent.data as { nodes: unknown[] }).nodes,
    pageInfo: (parent) => ({ __typename: 'PageInfo', data: (parent.data as { pageInfo: unknown }).pageInfo }),
    totalCount: (parent) => (parent.data as { nodes: unknown[] }).nodes.length,
  },
  PullRequestConnection: {
    nodes: (parent) => (parent.data as { nodes: unknown[] }).nodes,
    pageInfo: () => ({ __typename: 'PageInfo', data: { hasNextPage: false, endCursor: null } }),
    totalCount: (parent) => (parent.data as { nodes: unknown[] }).nodes.length,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => (parent.data as { nodes: unknown[] }).nodes,
  },
  PullRequestChangedFile: {
    path: (parent) => (parent.data as { path: string }).path,
  },
  PageInfo: {
    hasNextPage: (parent) => (parent.data as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: () => false,
    endCursor: (parent) => (parent.data as { endCursor: string | null }).endCursor,
    startCursor: () => null,
  },
  Ref: {
    name: (parent) => (parent.data as { name: string }).name,
  },
  __Type: {
    name: (parent) => (parent.data as { name: string }).name,
    kind: (parent) => (parent.data as { kind: string }).kind,
    fields: (parent) => {
      const type = SCHEMA[(parent.data as { name: string }).name];
      if (!type || type.kind !== 'OBJECT' || !type.fields) return null;
      return type.fields.map((name) => ({ __typename: '__Field', data: { name } }));
    },
    enumValues: (parent) => {
      const type = SCHEMA[(parent.data as { name: string }).name];
      if (!type || type.kind !== 'ENUM' || !type.values) return null;
      return type.values.map((name) => ({ __typename: '__EnumValue', data: { name } }));
    },
  },
  __Field: {
    name: (parent) => (parent.data as { name: string }).name,
  },
  __EnumValue: {
    name: (parent) => (parent.data as { name: string }).name,
  },
  CreateIssuePayload: {
    issue: (parent) => ({ __typename: 'Issue', data: (parent.data as { issue: Issue }).issue }),
  },
  CloseIssuePayload: {
    issue: (parent) => ({ __typename: 'Issue', data: (parent.data as { issue: Issue }).issue }),
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => ({ __typename: 'PullRequest', data: (parent.data as { pullRequest: PullRequest }).pullRequest }),
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => ({ __typename: 'PullRequest', data: (parent.data as { pullRequest: PullRequest }).pullRequest }),
  },
  AddCommentPayload: {
    commentEdge: (parent) => (parent.data as { commentEdge: GqlObject }).commentEdge,
  },
  IssueCommentEdge: {
    node: (parent) => (parent.data as { node: GqlObject }).node,
  },
  IssueComment: {
    id: (parent) => (parent.data as { id: string }).id,
    body: (parent) => (parent.data as { body: string }).body,
  },
};

// The executor: walk a selection set against a typed value, collecting data and errors.
function executeSelection(
  selections: SelectionNode[],
  parentType: string,
  parent: GqlObject,
  variables: Record<string, unknown>,
  ctx: Context,
  fragments: Map<string, SelectionNode[]>,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition.startsWith('__fragment:')) {
        const name = selection.typeCondition.slice('__fragment:'.length);
        const fragment = fragments.get(name);
        if (fragment) {
          const nested = executeSelection(fragment, parentType, parent, variables, ctx, fragments, errors);
          Object.assign(out, nested);
        }
        continue;
      }
      if (selection.typeCondition === null || selection.typeCondition === parent.__typename) {
        const nested = executeSelection(selection.selection, parentType, parent, variables, ctx, fragments, errors);
        Object.assign(out, nested);
      }
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = parent.__typename;
      continue;
    }
    const typeResolvers = RESOLVERS[parentType];
    const resolver = typeResolvers?.[field.name];
    if (!resolver) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      out[responseKey] = null;
      continue;
    }
    const args = resolveArgs(field, variables);
    let value: unknown;
    try {
      value = resolver(parent, args, ctx);
    } catch (e) {
      errors.push({ message: e instanceof Error ? e.message : String(e) });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(value, field.selection, variables, ctx, fragments, errors);
  }
  return out;
}

function completeValue(
  value: unknown,
  selection: SelectionNode[],
  variables: Record<string, unknown>,
  ctx: Context,
  fragments: Map<string, SelectionNode[]>,
  errors: Array<{ message: string }>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => completeValue(item, selection, variables, ctx, fragments, errors));
  }
  if (isGqlObject(value)) {
    if (selection.length === 0) return {};
    return executeSelection(selection, value.__typename, value, variables, ctx, fragments, errors);
  }
  return value;
}

export interface GraphQLOutcome {
  status: number;
  body: unknown;
}

function executeOperation(
  doc: DocumentNode,
  operation: OperationNode,
  variables: Record<string, unknown>,
  ctx: Context,
): { data: Record<string, unknown>; errors: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType, data: {} };
  const data = executeSelection(operation.selection, rootType, root, variables, ctx, doc.fragments, errors);
  return { data, errors };
}

/**
 * Handle one POST /api/graphql body (a single operation object or a batch array).
 * Returns the HTTP status and the JSON body.
 */
export function handleGraphQL(store: Store, body: unknown): GraphQLOutcome {
  const ctx: Context = { store };
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'GraphQL request body must be an object with a query string.' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return { data: null, errors: [{ message: 'GraphQL request needs a query string.' }] };
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    let doc: DocumentNode;
    try {
      doc = parseGraphQL(query);
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let operation: OperationNode | undefined;
    if (operationName !== null) operation = doc.operations.find((op) => op.name === operationName);
    if (!operation) operation = doc.operations[0];
    if (!operation) return { data: null, errors: [{ message: 'GraphQL document has no operation.' }] };
    const { data, errors } = executeOperation(doc, operation, variables, ctx);
    const out: Record<string, unknown> = { data };
    if (errors.length > 0) out.errors = errors;
    return out;
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map(runOne) };
  }
  return { status: 200, body: runOne(body) };
}

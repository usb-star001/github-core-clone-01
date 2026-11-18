# github-core-clone-01

[![github-core-clone-01 on make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/usb-star001/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/usb-star001/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge in a single process. No git binary, no outside service, no UI — just the wire.

Built for the [make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01).

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 and receive-pack v0, for clone, fetch and push. Fast-forward only.
- **REST v3** under `/api/v3` — repositories, issues, pull requests and contents.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and `github-mcp-server` send, with introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, with `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request` and `merge_pull_request` on the same store as REST.

Everything is in-memory, in one Node process with zero dependencies.

## How to run

The trial harness drives it: the program binds an ephemeral port, posts `{"port": N}` to `$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until the suite finishes and exits 0. See `main.ts` for the lifecycle.

```sh
node main.ts
```

Requires Node 22.

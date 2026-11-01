# cmdmark JSON-RPC protocol

The daemon listens on the Unix-domain socket `$XDG_RUNTIME_DIR/cmdmark.sock`. Socket permissions
are `0600`; the daemon requires a private, same-user runtime directory. Each UTF-8 JSON-RPC 2.0
request, response, or server notification occupies one newline-terminated frame. The daemon rejects
frames larger than 2 MiB. Binary PTY data is base64-encoded.

All domain types, method parameter/result maps, notifications, and runtime envelope validators live
in `packages/protocol/src/index.ts`. The Bun/Node socket client is exported from
`@cmdmark/protocol/client`.

## Request and response

```json
{"jsonrpc":"2.0","id":1,"method":"commands.search","params":{"query":"bun"}}
{"jsonrpc":"2.0","id":1,"result":{"hits":[],"fts5":true}}
```

Application errors use a JSON-RPC error response:

```json
{"jsonrpc":"2.0","id":2,"error":{"code":-32010,"message":"run already has an interactive attach"}}
```

Standard errors are `-32700` (parse), `-32600` (invalid request), `-32602` (invalid params), and
`-32603` (internal dispatch failure). Application errors currently use `-32000` for generic
service failures, `-32004` for missing records, `-32009` for non-attachable runs, and `-32010` for
an attach ownership conflict.

## Methods

| Method | Parameters | Result |
|---|---|---|
| `daemon.ping` | `{}` | daemon version and PID |
| `commands.list` | optional tag/favorite filters | command records |
| `commands.get` | `id` | command or null |
| `commands.create` | command draft | created command |
| `commands.update` | `id`, patch | updated command |
| `commands.delete` | `id` | whether a row was deleted; run history is retained |
| `commands.duplicate` | `id` | duplicated command |
| `commands.favorite` | `id`, favorite | updated command |
| `commands.search` | query, optional tag | ranked hits and whether FTS5 is active |
| `commands.export` | `{}` | versioned JSON bookmark bundle |
| `commands.importPreview` | JSON bundle text | validated drafts plus risky-pattern matches; no write or execution |
| `commands.import` | validated command drafts | atomically created bookmarks and risk matches; never starts commands |
| `runs.list` | optional state | run records |
| `runs.get` | `runId` | run or null |
| `runs.delete` | `runId` | delete one completed run and its saved log; active runs are rejected |
| `runs.clearHistory` | `{}` | delete completed run history and logs; active runs are preserved |
| `runs.start` | command ID or ad-hoc command; optional shell/cwd/env/params | new run |
| `runs.stop` | `runId`, optional grace period | stopped/escalated run |
| `runs.signal` | `runId`, signal | updated run |
| `runs.restart` | `runId` | new run record |
| `runs.logs` | `runId`, optional byte offset/limit | base64 bytes, next offset, truncation flag |
| `runs.subscribe` | optional run ID (omitted means all runs), optional `includeOutput` (default false) | subscription ID |
| `runs.unsubscribe` | subscription ID | unsubscribe result |
| `runs.attach` | `runId`, terminal columns/rows | attach result and recent output bytes/offset |
| `runs.write` | `runId`, base64 input | write result; requires attach ownership |
| `runs.resize` | `runId`, columns/rows | resize result; requires attach ownership |
| `runs.detach` | `runId` | detach result; does not stop the run |
| `settings.get` | `{}` | settings record |
| `settings.update` | partial settings | updated settings |

## Notifications

- `run.state`: a `RunRecord` after a state/process change.
- `runs.deleted`: the IDs of removed runs, broadcast to connected clients.
- `run.output`: `{runId, offset, dataBase64}`. `offset` is the absolute byte offset in the append-only
  log; notification data may split UTF-8 sequences, so consumers should decode incrementally.
- `commands.changed`: command ID and `created | updated | deleted`.
- `settings.changed`: the new settings record.

Run-state notifications are delivered only to clients subscribed to that run (or all runs).
Output notifications require `includeOutput: true` for the run (or all runs), or an interactive
attach. Command/settings change notifications are broadcast to connected clients.
Multiple log/state subscribers are supported. There is only one interactive input writer per run.

`runs.attach` returns a recent ring-buffer snapshot. Its `offset` is the starting byte offset for
`initialOutputBase64`; clients should set their cursor to `offset + decodedLength`, then ignore or
trim notifications whose byte ranges overlap that cursor. On disconnect, the daemon releases attach
ownership but leaves the run alone.

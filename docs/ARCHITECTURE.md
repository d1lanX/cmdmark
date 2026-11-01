# cmdmark architecture

cmdmark is a Linux desktop command library and process manager with a durable, headless daemon.
The GUI and CLI are clients of the daemon; closing either client does not stop managed processes.

## Packages

- `packages/protocol` owns the shared domain types, JSON-RPC request/response/notification shapes,
  runtime envelope validators, Unix-socket client, and daemon-autostart helper.
- `packages/daemon` owns SQLite migrations and CRUD/search, the `PtyBackend` seam, process
  supervision, logs/ring buffers, and the Unix-domain socket server.
- `packages/cli` owns `cmdmark` command dispatch, daemon launch, and interactive local-terminal
  attach. `cmdmark daemon --foreground` runs the daemon entry point.
- `packages/gui` owns the native gpuix-svelte client. It does not own child processes or SQLite.

The compiled CLI/daemon artifact is one executable in `dist/cmdmark`. A small `dist/cmdmarkd` shell
alias delegates to `cmdmark daemon --foreground`; this is needed because Bun normalizes argv0 in its
compiled binary. The GUI is compiled beside it as `dist/cmdmark-gui` through gpuix-svelte's Bun
shipping helper.

## Runtime data

- Socket: `$XDG_RUNTIME_DIR/cmdmark.sock`, mode `0600`.
- Database: `$XDG_STATE_HOME/cmdmark/cmdmark.sqlite`, or
  `~/.local/state/cmdmark/cmdmark.sqlite` when `XDG_STATE_HOME` is unset.
- Logs: `$XDG_STATE_HOME/cmdmark/logs/<run_id>.log`, or the corresponding default state directory.
- The state and log directories are created with mode `0700`; log files use mode `0600`.

## Process lifecycle

The daemon resolves a bookmark's shell command and starts it as `$SHELL -c <command>` with a Bun
PTY. The PTY spawn makes the shell a session and process-group leader on Linux; descendants inherit
the group unless they explicitly detach themselves. The backend records PID, PGID and `/proc` start
time so signals can be checked against PID reuse. Termination signals target the full process group.

The supervisor owns a bounded byte ring and append-only log for each active run. It records natural
exit code/signal, supports group signals and pause/resume, and escalates stop from SIGTERM to SIGKILL
after the configured grace period. Restart creates a new run with the prior resolved command.

On orderly daemon shutdown, the daemon closes the socket and stops active jobs. At daemon startup,
leftover `starting`, `running`, and paused `stopped` rows are checked against their recorded process
identity, signaled if their old process group remains, and marked `lost`. This is the v1 recovery
policy; it does not attempt to keep jobs alive across daemon restarts.

## Client/server boundary

All client requests and server notifications use the shared newline-delimited JSON-RPC 2.0 protocol
in `packages/protocol`. Unix socket permissions restrict access to the daemon owner. Run output is
base64-encoded in notifications so arbitrary PTY bytes survive JSON framing. Run log offsets are
byte offsets, not character or terminal-cell positions.

Any number of clients may subscribe to run state/output and read logs. Only one connection may own
interactive input for a run at once; later attach requests receive an application error until that
owner detaches or disconnects. The GUI never embeds a terminal emulator; interactive attach runs in
the user's external terminal. The GUI log list uses virtual rows and visible-range tail-following;
its GPUI thumb is not draggable, unlike the command/run `Scroller`.

## Extension seams

`PtyBackend` keeps process lifecycle operations behind `spawn`, `write`, `resize`, `kill`, and
`list`, allowing a future tmux-backed implementation without changing RPC clients. The v1 backend
is Bun's native PTY; no tmux support is included.

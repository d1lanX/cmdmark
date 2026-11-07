# cmdmark

cmdmark is a Linux command bookmark and process manager. Save shell commands, launch them through
`$SHELL`, inspect live status and logs, and stop, pause, resume, kill, or restart their process
groups. The desktop UI is rendered natively by GPUI through gpuix-svelte; there is no webview or
embedded terminal emulator.

## Requirements

- Linux x86_64 for the prebuilt CLI and GUI executables.
- A user session with `XDG_RUNTIME_DIR` set for the daemon socket.
- The GUI additionally requires `libxcb`, `libxkbcommon`, and `libxkbcommon-x11`.
- Bun **1.4.0** (pinned in `.bun-version`) is required only to build or run from source.

## Development

```bash
bun install
bun run start                 # native GUI; starts cmdmarkd on demand
bun run packages/cli/src/main.ts help
bun test                      # daemon, protocol, CLI and log parser tests
bun run typecheck             # strict TS and gpuix-svelte checks
bun run test:ui               # real Linux native-window automation
bun run build                 # dist/cmdmark, dist/cmdmarkd alias, and dist/cmdmark-gui
```

Linux's `@gpuix/native` prebuild does not include its headless test renderer. The GUI smoke test
therefore drives a real Linux window through gpuix-svelte automation; screenshot capture is not
available in that Linux automation backend.

## Install the CLI

Install the latest Linux x86_64 CLI release into `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/d1lanX/cmdmark/main/install.sh | sh
```

To choose another install directory:

```bash
curl -fsSL https://raw.githubusercontent.com/d1lanX/cmdmark/main/install.sh | sh -s -- --install-dir "$HOME/bin"
```

Make sure the install directory is on your `PATH`. The standalone CLI includes the daemon and
starts it on demand. It does not require Bun.

The [GitHub releases](https://github.com/d1lanX/cmdmark/releases) also include the
`cmdmark-gui-linux-x86_64` executable. Make it executable after downloading; the GUI needs the CLI
available on `PATH` (or beside the GUI executable) to start its daemon, as well as the desktop
libraries listed above.

## CLI commands

```text
cmdmark add <name> -- <shell command>
cmdmark list
cmdmark search <query>
cmdmark run <command_id> [--param name=value]
cmdmark run -- <shell command>
cmdmark ps
cmdmark stop <run_id>
cmdmark kill <run_id>
cmdmark logs <run_id> [--follow]
cmdmark attach <run_id>
```

`cmdmark attach` connects to the run's PTY from the caller's terminal. The default detach sequence
is Ctrl-]; detaching never stops the process. In the GUI, **Terminal** on a Library bookmark starts
it and opens the attach session; **Terminal** on an active run attaches to that existing session.
The selected or detected terminal emulator is used (including Terminator). If a short command
finishes before its terminal attaches, the terminal displays its saved output instead.

## Runtime files

- JSON-RPC socket: `$XDG_RUNTIME_DIR/cmdmark.sock` (`0600`, same-user access).
- SQLite database and append-only logs: `$XDG_STATE_HOME/cmdmark/`, defaulting to
  `~/.local/state/cmdmark/`.
- Closing the GUI or CLI leaves jobs running. Stopping the daemon terminates its active process
  groups; after an unclean restart, leftover active runs are cleaned up and marked `lost`.

## User systemd service

Install `systemd/cmdmarkd.service` under `~/.config/systemd/user/`, adjust `ExecStart` to the
installed `cmdmark` path, then run:

```bash
systemctl --user daemon-reload
systemctl --user enable --now cmdmarkd.service
```

See [docs/FINDINGS.md](docs/FINDINGS.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and
[docs/PROTOCOL.md](docs/PROTOCOL.md) for renderer constraints, architecture, and the RPC contract.

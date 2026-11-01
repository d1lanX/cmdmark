# gpuix-svelte and runtime findings

## Tested environment

- Linux x64, X11 (`DISPLAY=:0`; this spike did not test Wayland).
- Bun **1.4.0**.
- `gpuix-svelte` 0.3.0, bundled Svelte 5.57.2, and `@gpuix/native` 0.11.0.
- Bun requirement is pinned in `.bun-version` and declared as `engines.bun: >=1.4.0`.

The gpuix-svelte documentation describes Linux support for both X11 and Wayland. A Linux desktop
needs `libxcb`, `libxkbcommon`, and `libxkbcommon-x11`; minimal containers may need those packages
installed. This machine's spike ran under X11.

## What the renderer supports

gpuix-svelte renders Svelte 5 components directly into GPUI. It has no DOM or webview; use GPUI's
elements (`div`, `text`, `input`, `textarea`, `virtual-list`, `anchored`, etc.) and do not rely on
browser APIs or HTML semantics.

- **Text entry:** native `input` and `textarea`; values arrive on events such as `onchange` as
  `event.value`. There is no `bind:`. `input` submits on Enter; `textarea` inserts newlines unless
  `onsubmit` is provided (then Shift+Enter inserts a newline).
- **Lists and scrolling:** `Scroller` supplies a scroll column and a custom draggable thumb. With
  `virtual`, it renders a native `virtual-list`; each direct child is one row, rows should have
  `width: 100%`, and `estimate` is the height hint for unmeasured rows. `follow` maps to native
  tail-following for virtual lists. The native list paints only rows near the viewport; in the
  Linux automation tree the list container itself had no painted bounds, so the spike sent wheel
  input over a visible row.
- **Overlays and menus:** `Portal` paints modals/toasts over the tree; `Popover` can be positioned
  at right-click coordinates and is suitable for custom context menus; `Tooltip` is also included.
  There is no native context menu or `z-index`.
- **Keyboard/focus:** Tab and Shift+Tab navigate focusable elements by default. Use
  `on_window_key` for application shortcuts and implement list-specific arrow-key navigation.
- **Styling:** flexbox and a limited CSS-to-GPUI property set. Use pixel/rem lengths (percent and
  `auto` only on size properties), `flex-grow`, and `border-width`/`border-color`. No `display:none`,
  media queries, selector combinators, gradients, shadows, transforms, CSS transitions, or
  `z-index`. Use `{#if}` for conditional rendering and CSS variables via `set_css_vars` for themes.

## What cmdmark must compose

Inputs, virtualized rows, scrolling, popovers, and portal layers already exist; we should compose
them rather than recreate low-level primitives. The app still needs reusable field/editor
components, selection and keyboard navigation for command/run rows, confirmation dialogs, and
context-menu actions.

The log viewer uses a small virtual-list wrapper: `Scroller` keeps its virtual-list visibility
callback and scroll state internal, while cmdmark needs to turn tail-following off when the user
scrolls away and turn it back on at the tail. The wrapper tracks visible row indices and passes a
`followTail` state to the native list. Its colored GPUI thumb is not draggable; command/run lists
use `Scroller`'s draggable thumb. If a draggable log thumb is required, the smallest extension is a
`Scroller` callback for visible ranges or a custom thumb in the log wrapper. Logs remain read-only
text; this does not implement a terminal emulator.

Use the native renderer's existing hit testing. Mouse events do not bubble; use `hitbox="self"`
where a clickable parent should receive clicks over decorative children.

## Spike results

All three required spikes passed on **Bun 1.4.0 / Linux x64**:

1. **PTY:** `Bun.spawn(["bash"], { terminal })` accepted a command through
   `proc.terminal.write()`, returned its output through the terminal data callback, resized to
   103 columns × 37 rows (`stty size` reported `37 103`), printed `PTY_OK`, and exited with code 0.
2. **Process group:** spawned `sh -c "sleep 100 & echo CHILD=$!; wait"` with a PTY. `ps` showed
   the shell's PID, PGID, and SID were identical. `process.kill(-pid, "SIGTERM")` exited the shell
   with signal-derived status 143 and the child PID was absent afterwards. Bun's PTY spawn already
   makes the shell a session/process-group leader; no `setsid` wrapper is needed for this path.
3. **UI:** a minimal native window used `input`, a clickable control, and `Scroller virtual`. Linux
   window automation filled the input (`typing works`), clicked the control (count became 1),
   scrolled over a visible row, and found virtual row 45. The first driver attempt was invoked
   without gpuix-svelte's custom-renderer conditions and failed before app startup; invoking it
   through the documented gpuix-svelte runner passed. This was a runner configuration issue, not a
   Linux UI failure.

SQLite FTS5 was also verified in an in-memory Bun database by creating an FTS5 virtual table,
inserting a row, and retrieving it with `MATCH`; cmdmark can use FTS5 rather than a TypeScript-only
fallback on this runtime.

## Tests and packaging constraints

gpuix-svelte's headless GPU test renderer is documented for macOS and Windows. On Linux, use its
automation driver against a real native window for GUI interaction checks; Linux automation works,
but screenshot capture is not supported there. Confirmed locally: `bun run test` fails at
`mount_headless` with `[gpuix-svelte/test] this @gpuix/native build has no TestGpuixRenderer (the
Linux prebuild ships without one)`. This is a platform limitation, not a UI spike failure; the
native-window automation spike passed. Daemon, CLI, protocol, and SQLite behavior can still be
tested with `bun test`.

The gpuix-svelte shipping helper can compile a GUI entry into a standalone Bun executable, one
platform per build. A daemon/CLI executable can be compiled separately with Bun; the Linux GUI
binary still depends on the system XCB/XKB libraries. This matches the requested two artifacts: a
combined daemon/CLI binary plus a GUI binary.

## Substrate reference

Substrate was moved out of the gpuix-svelte repository on 2026-10-12. Its last in-tree source
snapshot demonstrates `bun:sqlite` migrations, WAL/foreign-key configuration, FTS5 triggers, and a
`Bun.spawn` worker using IPC. It is a useful Bun/native-GPUI reference, but its worker architecture
is not a replacement for cmdmark's daemon and Unix-socket JSON-RPC design.

- [Substrate README at the last in-tree snapshot](https://raw.githubusercontent.com/khromov/gpuix-svelte/61b90280372aa12723d04c90091ea0e2118a2ff0/examples/second-brain/README.md)
- [gpuix-svelte overview](https://gpuix-svelte.stanislav.garden/overview.md)
- [Styling](https://gpuix-svelte.stanislav.garden/styling.md)
- [Components](https://gpuix-svelte.stanislav.garden/components.md)
- [Guide: inputs and keyboard](https://gpuix-svelte.stanislav.garden/guide.md)
- [Testing](https://gpuix-svelte.stanislav.garden/testing.md)
- [Shipping](https://gpuix-svelte.stanislav.garden/shipping.md)

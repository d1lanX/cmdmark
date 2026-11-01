# AGENTS.md

This is a Bun workspace for cmdmark, a Linux desktop command manager. The GUI is made with Svelte 5
components rendered into a native GPUI window by gpuix-svelte; the daemon and CLI use Bun/TypeScript
and communicate with that GUI over the shared Unix-socket JSON-RPC protocol. Pin Bun 1.4.0.

## Documentation

GPUI's elements, styling and events follow their own rules, so read the docs before writing UI code.
Fetch https://gpuix-svelte.stanislav.garden/llms.txt, then the pages it links for the task at hand.

## Commands

```bash
bun install
bun run start         # native GUI; starts cmdmarkd on demand
bun test              # daemon, CLI, protocol and log-parser tests
bun run typecheck     # strict TS and svelte-check against GPUI's element types
bun run test:ui       # real Linux window automation
bun run build         # combined cmdmark/cmdmarkd and separate cmdmark-gui binaries
```

The Linux prebuild does not include gpuix-svelte's headless test renderer. Use the real-window
automation smoke test for GUI interactions; screenshot capture is not available in that Linux
automation backend. After code changes, run `bun run typecheck` and `bun test`.

## Building

**Building standalone executables requires Bun >= 1.4.0.**

`bun run build` compiles the CLI/daemon and GUI as separate standalone executables for the current
platform. The CLI executable dispatches daemon and CLI commands, with a `cmdmarkd` alias; the GUI
is built by gpuix-svelte's custom-renderer Bun plugin.

- The build is platform-specific. The Linux GUI executable still needs system XCB/XKB libraries.
- `packages/gui/standalone.ts` statically imports `App.svelte` because a compiled binary cannot
  hot-reload source files.

## Writing components

- Elements are GPUI's: `div`, `text`, `img`, `svg`, `input`, `textarea`, `code`, `markdown`,
  `virtual-list`, `anchored`. `<img src>` takes a file path, a `data:` URL or an http(s) URL, plus
  a width and a height.
- Style with `<style>` class rules (`.btn`, `.btn.primary`, `.btn:hover`, `.btn:active`,
  `.btn:focus-visible` with `outline-*` for the keyboard focus ring) and inline
  `style=`. Layout is flexbox in logical pixels: lengths in `px` or `rem` (16 px), and `%`/`auto` for `width`,
  `height`, `min-*` and `max-*`. Use `flex-grow: 1` for `flex: 1`, and `border-width` plus
  `border-color` for `border`. The styling page lists every property.
- Colours go in `var(--token)`, with the palette set once from the root through
  `set_css_vars({ token: '#fff' })`.
- Inputs report through events: `<input value={text} onchange={(e) => (text = e.value)} />`.
  `{@attach (node) => ...}` hands you an element.
- A click goes to the element under the pointer. Put `hitbox="self"` on a clickable element whose
  children paint a background, and it receives their clicks. `onclick` is the primary button; right
  and middle clicks are `onauxclick`.
- App-wide keyboard shortcuts: `on_window_key('keydown', handler)` from `gpuix-svelte`, returned
  from an `$effect` so it unsubscribes. Tab and Shift+Tab already move focus between `tabindex`
  elements; don't wire them to `focus_next()`, and call `e.preventDefault()` in a key handler to
  keep a Tab.
- On GNOME under Wayland, which draws no title bar for the window, `render()` draws one (title,
  minimise, maximise, close) and mounts the app in the box below it, which its `rootStyle` styles.
  `render(App, { titlebar: false })` turns it off, `true` draws it everywhere.
- Scrolling content goes in `Scroller` (`gpuix-svelte/components/Scroller.svelte`), which draws the
  scrollbar; modals, menus and toasts go in `Portal` (`gpuix-svelte/components/Portal.svelte`),
  which paints on top; hover tips and dropdowns that sit beside a trigger go in `Tooltip` and
  `Popover` from the same directory.
- State that should survive a hot reload goes in a `.svelte.ts` module; editing one needs a restart.
- Handlers take `GpuixEvent` and `{@attach}` gets a `ShadowNode`, both importable as types from
  `gpuix-svelte`.

## TypeScript

`.ts` files run through Node's and Bun's built-in type stripping, not a compiler, and `tsconfig.json`
enforces what that allows: no enums, namespaces or constructor parameter properties, `import type`
for anything that is only a type, and relative imports spelled with their extension (`./util.ts`).

## Dependencies

`gpuix-svelte` brings its own build of Svelte, the one with the custom renderer API, and resolves
every `svelte` import to it. Keep `svelte` itself out of `package.json`.

## Files

- `packages/protocol` — shared RPC types/validators, socket client, autostart, templates, and bookmark JSON.
- `packages/daemon` — SQLite, supervisor/PTY backend, Unix socket, and daemon entry.
- `packages/cli` — `cmdmark` command dispatcher and compiled CLI/daemon build.
- `packages/gui` — native Svelte GUI, automation smoke test, standalone entry, and GUI build.
- `docs/FINDINGS.md`, `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md` — renderer research and design docs.
- Root `tsconfig.json` and `package.json` — workspace TypeScript and Bun scripts.

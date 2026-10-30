---
name: browser-harness
description: Use for browser automation and requests to connect to an already-open Chrome/Chromium browser, even when no CDP endpoint is supplied. Resolve the requested local browser's DevToolsActivePort when needed; use Steel only when no external browser is requested. Prefer browser_snapshot and targeted DOM reads.
---

# Browser Harness

## Connection

Steel is the default in every new Pi session. Its API creates and releases live sessions,
restoring the active Pi Profile's persisted SessionContext from `steel.json`.
`browser_setup()` connects on demand and returns the Steel live viewer when available.
A person can interact with that same browser; do not assume exclusive control.

### Interpret intent before choosing a provider

A request such as "connect to my already-open Chrome", "use my local browser", or
"use Chrome on port 9222" explicitly selects an external browser, even without a URL.
Do not start Steel, require the user to know CDP terminology, or ask for an endpoint
before attempting the bounded local resolution below. A port alone is not proof of
an HTTP discovery endpoint. The user enables debugging; the agent resolves the address.

If an endpoint was supplied, call `browser_setup({endpoint: "..."})` before other
browser tools. HTTP(S) base URLs resolve through `/json/version`; browser WebSocket
URLs connect directly. If the selected connection already matches the request, reuse it.

### Resolve an explicitly requested local browser

1. Use the browser, port, or data-directory path provided in the request. Do not invent
   missing parameters or assume every browser uses port 9222.
2. Read only the requested browser's `DevToolsActivePort` connection-metadata file.
   This narrow filesystem read is permitted by the user's request to connect; it does
   not authorize browsing unrelated profiles, reading cookies/password databases,
   changing settings, launching processes, or enabling debugging automatically.
3. For a standard local installation, these are candidate data roots (not individual
   `Default` or `Profile N` subdirectories). Respect an explicit custom data root and
   `XDG_CONFIG_HOME` instead of assuming the defaults:

   | Browser | Linux | macOS | Windows |
   | --- | --- | --- | --- |
   | Chrome | `~/.config/google-chrome` | `~/Library/Application Support/Google/Chrome` | `%LOCALAPPDATA%/Google/Chrome/User Data` |
   | Chromium | `~/.config/chromium` | `~/Library/Application Support/Chromium` | `%LOCALAPPDATA%/Chromium/User Data` |
   | Brave | `~/.config/BraveSoftware/Brave-Browser` | `~/Library/Application Support/BraveSoftware/Brave-Browser` | `%LOCALAPPDATA%/BraveSoftware/Brave-Browser/User Data` |
   | Edge | `~/.config/microsoft-edge` | `~/Library/Application Support/Microsoft Edge` | `%LOCALAPPDATA%/Microsoft/Edge/User Data` |

   Use only the candidate for the named browser on the actual OS. Do not recursively
   scan the home directory, enumerate all personal profiles, or probe arbitrary ports.
4. The file has a port on line 1 and a WebSocket path on line 2, for example:

   ```text
   9222
   /devtools/browser/current-instance-id
   ```

   Validate an integer port in 1–65535 and a path starting with `/devtools/browser/`.
   Construct `ws://127.0.0.1:<port><path>` and pass it to `browser_setup`. If the user
   specified a port, require it to match; otherwise ask which instance was intended.
5. If the file is absent, unreadable, malformed, or the browser is ambiguous, ask only
   for the missing detail: browser name, data root, or the `Profile Path` field from
   `chrome://version`. For `.../Default` or `.../Profile N`, its parent is the data root.
   Explain permission/sandbox or different-machine limitations instead of bypassing them.
6. If no metadata file is available but the user gave an explicit local port, try HTTP
   discovery once on that port. If neither route works, report the actual blocker.
   Do not ask the user to repeat information already available in this conversation.

This procedure is for an explicitly requested browser on the same machine as Pi.
Do not inspect a remote host/container or assume its loopback is the user's desktop.
Remote connection or diagnostics require explicit authorization for that environment.

### Chrome UI-enabled debugging: HTTP 404 is not a closed port

Modern Chrome enabled through `chrome://inspect/#remote-debugging` can expose only a
WebSocket endpoint. Its listening port can return **HTTP 404 for `/json/version`**.
This does not mean debugging is disabled, the user's port is wrong, or Chrome needs
to be restarted. Resolve the current `DevToolsActivePort` and connect directly by
WebSocket. Ask the user to approve Chrome's connection dialog; never approve it for them.

Do not blindly repeat HTTP discovery, ask for the same screenshot/address again, or
instruct the user to restart with flags just because HTTP discovery returned 404.
For a supplied remote endpoint, do not read local metadata as a substitute.

WebSocket instance IDs can change after restart. Prefer the live metadata over an old
URL from a screenshot or previous conversation. When the user references earlier setup,
use `conversation_search` to recover it, but verify local connection metadata before reuse.
If connection times out while Chrome may be waiting for approval, ask the user to check
the dialog and retry after approval, without silently switching providers.

Selection lasts for the current Pi session only. An empty `browser_setup()` preserves
that selection and reconnects it. Use `browser_setup({provider: "steel"})` to return
to Steel. An explicit CDP failure must never silently fall back to Steel.
External connections do not have a Steel viewer or export their cookies to Pi.
`/browser-status` identifies the selection; `/browser-release` disconnects it, retaining
the selection for reconnection. It does not terminate an external browser.

Do not type credentials. Ask the user to handle authentication, MFA, CAPTCHA, or payment
confirmation. Do not expose endpoint credentials or query tokens in status messages.

## Tool hierarchy

- Page structure or clickable elements: `browser_snapshot`.
- A specific value, attribute, or geometry: `browser_execute_js`.
- Reader-mode article text: `browser_read_page`.
- JavaScript errors: `browser_console`.
- Requests and responses: `browser_network_requests`.
- Pixels, layout, colors, or charts: screenshots only for visual verification.

## Interaction rules

Snapshots return refs such as `[e7]`. Use those refs rather than guessed selectors
or coordinates. Prefer `browser_fill` for forms and `browser_wait_for` over fixed delays.
After a mutation, inspect the returned page-change diff. Refresh the snapshot when a
ref is stale or the browser connection changes; never blindly retry old refs.

## Tabs and isolation

The harness opens dedicated agent tabs by default. `browser_list_tabs` with `scope:'all'`
can list other tabs. In external CDP mode only, when the user explicitly requests control
of an existing tab, call `browser_switch_tab({targetId: "...", authorizeExisting: true})`.
Authorization allows interaction but never allows closing that existing tab.
`scope:'owned'` includes both created and authorized tabs, marked separately.

A request to connect to a browser is not blanket authorization to read all its tabs.
Once connected, complete the requested task without asking for technical setup details
that were already resolved. If the user only asked to connect, confirm the connection;
no navigation or tab inspection is necessary.

Only tabs created by the harness are closed during release or shutdown. Connection
switches wait for in-flight tools and discard previous references and ownership state.
Do not reuse sessions or credentials from another Pi Profile without explicit authorization.

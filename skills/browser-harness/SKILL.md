---
name: browser-harness
description: Use when the user wants to automate, scrape, test, or interact with web pages. Controls Steel by default or an explicitly supplied external CDP browser. Prefer browser_snapshot for structure and browser_execute_js for surgical reads; use screenshots only for visual verification.
---

# Browser Harness

## Connection

Steel is the default in every new Pi session. Its API creates and releases live sessions,
restoring the active Pi Profile's persisted SessionContext from `steel.json`.
`browser_setup()` connects on demand and returns the Steel live viewer when available.
A person can interact with that same browser; do not assume exclusive control.

When the user supplies an external browser endpoint, call
`browser_setup({endpoint: "http://127.0.0.1:9222"})` before other browser tools.
HTTP(S) base URLs resolve through `/json/version`; browser WebSocket URLs connect directly.
The user prepares and enables debugging in that browser. Do not launch browsers,
discover local profiles, or copy credentials automatically.

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

Only tabs created by the harness are closed during release or shutdown. Connection
switches wait for in-flight tools and discard previous references and ownership state.
Do not reuse sessions or credentials from another Pi Profile without explicit authorization.

---
name: browser-harness
description: Use when the user wants to automate, scrape, test, or interact with web pages. Controls the Steel browser assigned to the active Pi Profile through CDP. Prefer browser_snapshot for page structure and browser_execute_js for surgical reads; use browser_screenshot only for visual verification.
---

# Steel Browser Harness

The active Pi Profile owns a persisted Steel SessionContext in its `steel.json`. Steel API creates and releases the live browser session; the harness restores cookies and storage through that API context. Do not ask for, create, select, or launch a local Chrome profile.

## Connection

Browser control is on demand. Call `browser_setup` when a browser tool reports that it is not connected. It creates a Steel Session through the Steel API, restores the active Pi Profile's persisted context, connects to the session CDP endpoint, and returns the live viewer URL. A person may open that URL and interact with the same tabs at the same time; do not assume exclusive browser control.

Do not type credentials. If authentication, MFA, CAPTCHA, or a payment confirmation is required, stop and ask the user to take over.

## Tool hierarchy

- Page structure or clickable elements: `browser_snapshot`.
- A specific value, attribute, or geometry: `browser_execute_js`.
- Reader-mode article text: `browser_read_page`.
- JavaScript errors: `browser_console`.
- Requests and responses: `browser_network_requests`.
- Pixels, layout, colors, or charts: `browser_screenshot` only as a last resort.

## Interaction rules

`browser_snapshot` returns stable element refs such as `[e7]`. Use refs with `browser_click`, `browser_fill`, `browser_select_option`, `browser_focus`, and keyboard tools. Do not use screenshots to locate controls. Do not guess selectors when a ref exists.

After a mutating action, inspect the returned page-change diff. If a ref is stale, take a new snapshot; never retry it blindly. Use `browser_wait_for` instead of fixed delays.

## Isolation

Operate only on agent-owned tabs. Browser state is isolated by Pi Profile through its persisted Steel SessionContext. Do not attempt to reuse a tab, session, cookie, or storage state from another Pi Profile.

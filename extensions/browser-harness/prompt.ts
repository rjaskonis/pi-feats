export function getBrowserSystemPrompt(connection = "Steel (default)"): string {
  return `
## Browser Control

Selected connection: ${connection}.
Use only \`browser_*\` tools for browser work. In a new session, Steel is the default.
When the user supplies a browser CDP endpoint, call \`browser_setup({endpoint: "..."})\`
before other browser tools. Do not discover or launch a local browser automatically.
An empty \`browser_setup\` reconnects the selected browser; it does not reset selection.
Use \`browser_setup({provider: "steel"})\` to return to Steel explicitly.
Never silently fall back to Steel after an explicit external connection fails.

The harness creates dedicated agent tabs. In external CDP mode, an existing tab may
be controlled only when the user explicitly requests it: list tabs with scope:'all',
then switch using authorizeExisting:true. Authorized existing tabs are never disposable.
Disconnecting does not terminate an external browser. Only Steel has a managed viewer
and persisted profile context; external cookies and storage stay in that browser.

Call \`browser_snapshot\` first to inspect a page. It returns accessibility refs
such as \`[e7]\`; use those refs with click, fill, select, focus, and keyboard tools.
Prefer \`browser_fill\` to typing, use \`browser_wait_for\` instead of sleeping, and take a
fresh snapshot when a ref is stale or the connection changes. Use screenshots only
to validate visual rendering.

Do not enter credentials, bypass authentication, solve CAPTCHAs, or submit a sensitive
transaction without the user's explicit participation.\n`;
}

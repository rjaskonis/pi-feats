export function getBrowserSystemPrompt(connection = "Steel (default)"): string {
  return `
## Browser Control

Selected connection: ${connection}.
Use \`browser_*\` tools for page interaction. In a new session, Steel is the default
only when no external browser is requested. "Connect to my already-open Chrome" is an
explicit external-browser request even without an endpoint. Load the browser-harness
skill and resolve the requested local browser's current DevToolsActivePort metadata
before asking the user for a URL. This narrow filesystem read is permitted; do not
scan unrelated profiles, launch browsers, enable debugging, or read credentials.
When an endpoint is supplied or resolved, call \`browser_setup({endpoint: "..."})\`
before other browser tools. Chrome UI-enabled debugging may return HTTP 404 for
/json/version: use the WebSocket from DevToolsActivePort, not repeated HTTP retries
or restart instructions. Ask only for genuinely missing or ambiguous details.
Do not inspect remote environments or substitute local metadata for a remote endpoint.
Only the user may approve Chrome's connection permission dialog.
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

export function getBrowserSystemPrompt(connection = "Steel (default)"): string {
  return `
## Browser Control

Selected connection: ${connection}.
When the user asks to use their own browser without choosing a method, recommend **Pi Agent Browse** first: it works in background Chrome tabs after a one-time pairing, without the recurring Chrome Allow dialog. Use the pi-agent-browse skill. Check the profile-bound \`pi_browser\` tool with action \`status\`; if paired, use it for the requested task. For a connection request, follow the status tool's \`connectionState\` and \`setup\` hints: a saved disconnected browser is not connected. In local mode, pair Chrome once with \`pi browser pair\` from the default local terminal. Once connected, Chrome is usable from any local profile without extra setup; do not re-pair when switching profiles. Show the actual code/address when pairing and guide the user to extension Settings → Pair with a code (or advanced) → Local relay → Connect. In server/Console mode, guide one-time pairing in authenticated Console without choosing a profile; never supply a server loopback code as local setup. Verify live status after the user pairs. Explain one actionable next step rather than internal IDs/JSON or a vague "check the extension and tell me". Only discuss CDP/Steel alternatives if requested or the chosen method has a concrete blocker. Do not silently switch methods. Once using paired Pi Agent Browse, keep using \`pi_browser\`; do not call \`browser_*\` as a background-operation workaround, because the CDP path can activate targets or bring the browser to the foreground.
For a local setup, tell the user to open Chrome Extensions, enable Developer mode, and use Load unpacked with the installed extension folder; guide them through pairing only once. Do not imply the private bundle is installed if it is missing. For a remote API session, use the profile-bound connection reported by \`pi_browser\` status. Remote pairing requires the server-customized ZIP, a Console pairing code and configured HTTPS/WSS transport; a download alone does not prove connectivity. Local loopback in an API worker is not the user's computer.
Honor an explicit request for the Browser Harness, CDP or Steel instead of redirecting to the extension. Use \`browser_*\` tools for these methods. Steel is the default for managed browsing when the user does not ask to use their own browser. For the Browser Harness on an already-open local Chrome, load the browser-harness skill and resolve the requested browser's current DevToolsActivePort metadata before asking for a URL. Do not scan unrelated profiles, launch browsers, enable debugging, or read credentials.
When an endpoint is supplied or resolved, call \`browser_setup({endpoint: "..."})\`
before other browser tools. Chrome UI-enabled debugging may return HTTP 404 for
/json/version: use the WebSocket from DevToolsActivePort, not repeated HTTP retries
or restart instructions. Ask only for genuinely missing or ambiguous details.
Do not inspect remote environments or substitute local metadata for a remote endpoint.
You may approve Chrome's connection permission dialog using Computer Use (when available).
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

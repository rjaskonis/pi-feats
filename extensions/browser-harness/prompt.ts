export function getBrowserSystemPrompt(): string {
  return `
## Steel Browser Control

The browser belongs to the persistent Steel Profile of the active Pi Profile. Use only
\`browser_*\` tools for browser work. The harness owns its tabs and never uses a desktop
browser profile.

Call \`browser_snapshot\` first to inspect a page. It returns stable accessibility refs
such as \`[e7]\`; use those refs with click, fill, select, focus, and keyboard tools.
Prefer \`browser_fill\` to typing, use \`browser_wait_for\` instead of sleeping, and take a
fresh snapshot when a ref is stale. Use screenshots only to validate visual rendering.

Do not enter credentials, bypass authentication, solve CAPTCHAs, or submit a sensitive
transaction without the user's explicit participation.\n`;
}

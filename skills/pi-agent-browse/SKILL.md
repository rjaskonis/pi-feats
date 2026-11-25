---
name: pi-agent-browse
description: Use paired Pi Agent Browse for personal Chrome requests, or guide local Node relay and remote profile-bound WSS pairing without replacing an explicit CDP/Steel choice.
---

For a generic “use my browser” or “open this in my Chrome” request, prefer **Pi Agent Browse** when available. It uses background tabs after one-time pairing. Honor explicit Browser Harness, CDP or Steel choices instead; follow the browser-harness skill for those methods. Never silently switch providers.

## First-time setup

Check `pi_browser` with `action: "status"`. If it is not paired, explain the next setup step plainly rather than presenting internal paths as an installed product.

- **Pi and Chrome on this computer:** download the extension ZIP from Console → Administrative Settings → Pi Agent Browse, extract it to a stable folder, then load it at `chrome://extensions` → Developer mode → Load unpacked. With Pi and `pi-feats` installed on that computer, run `pi browser pair`. It starts the package's Node relay if needed and prints a five-minute single-use code and exact loopback address. In extension Settings choose **Local relay**, enter that address/code and Connect. `pi browser install`, `status`, `unpair` and `stop` are also available. Named profiles use `pi profile <name> browser pair`; never install packages into their workspaces. No upstream installer or separate native binary is required.
- **Pi on another server:** use that server's Console. Select the intended Pi Profile and generate a code, then paste it into **Remote server** in the extension downloaded from that server. No Pi/local relay installation is required on the Chrome computer. The server must have a public HTTPS origin and `/api/browser/connect` WSS routing. An unavailable status is a real configuration blocker: do not invent a code or claim the download alone proves connectivity.

Only the ZIP download is public. Pairing management is authenticated. Never put API credentials in the extension or ask the user to paste administrative API tokens. Do not perform remote installation, configuration, restarts or tests without explicit authorization. Do not present a server's loopback endpoint or filesystem paths as the user's local computer.

## Operate

1. Use `pi_browser` with `action: "status"`. If multiple browsers are connected, choose the intended browser ID. This tool receives an already profile-bound capability; never supply another profile, token or endpoint.
2. Use `action: "navigate", url: "https://…"` without `tabId` to create an inactive tab. Retain its returned browser and numeric tab ID. Include `tabId` for later actions. Only tabs created in this profile's current connection are available. Existing personal tabs and tabs from an old connection are not automatically adopted. Do not claim the tool can take over a personal tab.
3. Take `action: "snapshot"` before interacting. Use its `b…` refs with `click` or `fill` (`text` is the desired value). Refresh the snapshot after navigation or re-render, or a stale-ref failure. `press` supports Enter, Tab, Escape, Backspace, Delete and arrow keys. Use `scroll` with `deltaY`.
4. For targeted DOM data use `evaluate` with a bounded `expression`. For lists and chronological answers, verify coverage and actual records rather than treating a truncated snapshot or unrendered data as absent. Use `screenshot` only for visual validation, not routine exploration.
5. Verify important actions. Leave a requested page open; use `close` only for an agent-created tab. Do not change extension settings without a request. Ask the user to complete credentials, CAPTCHAs or sensitive confirmations; do not bypass authentication.

The older private native `pi-agent-browse` CLI/MCP installation is a separate legacy method with separate pairing state. Do not assume it exists or fall back to it automatically. CDP/Steel remain available when explicitly selected.

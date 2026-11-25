---
name: pi-agent-browse
description: Use paired Pi Agent Browse for personal Chrome requests, or guide local Node relay and remote profile-bound WSS pairing without replacing an explicit CDP/Steel choice.
---

For a generic “use my browser” or “open this in my Chrome” request, prefer **Pi Agent Browse** when available. It uses background tabs after one-time pairing. Honor explicit Browser Harness, CDP or Steel choices instead; follow the browser-harness skill for those methods. Never silently switch providers.

## Guided connection: do the technical work, explain only the next user action

A request to connect authorizes checking status and generating a temporary local pairing code from the default local terminal. It does not authorize granting a named profile access on the user's behalf, installing packages, modifying remote configuration, revoking existing credentials or taking control of an existing personal tab. Reply in the user's language; keep the English labels they will see in Chrome. Do not expose browser IDs, JSON, internal paths or implementation terms such as broker/worker unless troubleshooting requires them.

1. Check `pi_browser` with `action: "status"`. Read `connectionState` and `setup.mode/nextStep`. A saved browser with `connected: false` is NOT a live connection, and does not prove the extension is installed or ready on this computer. Never say "connected" until a live status check confirms it.
2. If connected, confirm briefly and perform the requested task. Do not generate a code, explain installation, or ask them to pair again.
3. If the user asks to connect and no browser is connected, take the appropriate local/Console branch below immediately. Do not merely tell them to "check the extension and let me know", or wait for them to know they need a pairing code. If they only asked for status, report it without creating a code.

### Local connection

One relay and one Chrome pairing serve all authorized local profiles. If `setup.nextStep` is `grant_profile_access`, ask the user to run `pi browser grant <active-profile>` in a terminal outside the named profile (use `default` for the default profile). Do not re-pair or try to self-authorize. If it is `check_chrome_connection`, ask the user to open Chrome and check extension settings; generate another code only if the extension actually needs pairing.

If Chrome has not been paired or the relay is not running, use `pi browser pair` from the default local terminal to start the shared relay and generate a five-minute single-use code. A named profile cannot administer the relay: ask the user to run that command outside it. If Chrome was already paired before the relay stopped, use `pi browser install` to restart it, then check status before generating another code. Never guess an address, code or expiry; use the command result.

Show a short, complete checklist, using the returned address and code:

1. Open Pi Agent Browse settings in Chrome. Offer the `setup.extensionSettingsUrl` to copy into the Chrome address bar, or `chrome://extensions` → **Pi Agent Browse** → **Details** → **Extension options**. Clicking the toolbar icon is NOT a reliable way to open settings: it may authorize the current personal tab.
2. Click **Pair with a code** if shown; otherwise expand **advanced** ("relay address, pairing code, diagnostics"). Under **Connect to**, choose **Local relay**.
3. Give separate clearly labeled **Local relay address** and **Pairing code** values, then say to click **Connect**. Explain in one sentence that the code expires in five minutes and only the latest generated code is valid. Do not describe a loopback address as a public website.

Do not assume the user knows where settings or the pairing form are. If they say the extension is already installed, skip download and installation instructions. If it is not installed, give only the missing installation steps: download ZIP from Console → Administrative Settings → Pi Agent Browse, extract to a stable folder, then `chrome://extensions` → Developer mode → **Load unpacked**, selecting the folder containing `manifest.json`. Generate the code after installation if the initial code would expire. Do not claim a standard folder is installed without checking.

After Chrome connects, ask for an explicit `pi browser grant <active-profile>` from the default local terminal if needed. Subsequent profiles need only a grant, not another Chrome pairing. Offer to verify the connection and profile access. Recheck status once after a short bounded wait if execution can continue; otherwise check immediately when the user responds. Never end with only "tell me when connected" without verification. Do not poll indefinitely, regenerate codes while waiting, repeat installation instructions, or open an unrelated task. If still disconnected, explain the one next check: exact address from this code generation, correct Local relay mode, or the error shown in the extension. Ask for that error or a screenshot rather than cycling through generic advice. Do not claim there is a **Reconnect** button unless it is actually shown.

### Console / server connection

When `setup.mode` is `console`, local shell commands run on the server, NOT the user's Chrome computer. Never run `pi browser pair` there to supply a supposed local code. Guide the user to **Console → Administrative Settings → Pi Agent Browse → Connect Chrome → Pi on another server**, select this session's Pi Profile, and generate a code. In extension settings, open the pairing form as above, choose **Remote server**, check the server address, paste the code and click **Connect**. If authorized Console access is actually available, perform the permitted steps yourself instead of making the user repeat them. Do not claim Console generation occurred unless its real response was observed; worker capabilities cannot administer pairing.

If `setup.nextStep` is `administrator_setup_required`, explain plainly that the server's secure browser connection must be configured by its administrator. The ZIP alone is not sufficient. Do not switch modes, install a local relay, guess a public URL, or attempt remote configuration. The server requires a public HTTPS origin and WSS routing.

Only the ZIP download is public. Pairing management is authenticated. Never put API credentials in the extension or ask the user to paste administrative API tokens. Do not perform remote installation, configuration, restarts or tests without explicit authorization. Do not present a server's loopback endpoint or filesystem paths as the user's local computer.

## Operate

1. Use `pi_browser` with `action: "status"`. If multiple browsers are connected, choose the intended browser ID. This tool receives an already profile-bound capability; never supply another profile, token or endpoint.
2. Use `action: "navigate", url: "https://…"` without `tabId` to create an inactive tab. Retain its returned browser and numeric tab ID. Include `tabId` for later actions. Only tabs created in this profile's current connection are available. Existing personal tabs and tabs from an old connection are not automatically adopted. Do not claim the tool can take over a personal tab.
3. Take `action: "snapshot"` before interacting. Use its `b…` refs with `click` or `fill` (`text` is the desired value). Refresh the snapshot after navigation or re-render, or a stale-ref failure. `press` supports Enter, Tab, Escape, Backspace, Delete and arrow keys. Use `scroll` with `deltaY`.
4. For targeted DOM data use `evaluate` with a bounded `expression`. For lists and chronological answers, verify coverage and actual records rather than treating a truncated snapshot or unrendered data as absent. Use `screenshot` only for visual validation, not routine exploration.
5. Keep the browser in the background. The relay uses page-level focus emulation, not foreground window activation. Do not call `window.focus()`, activate a tab, raise a window, or switch to CDP/another tool merely to make a page load or respond. Report a background-operation failure rather than stealing focus.
6. Verify important actions. Leave a requested page open; use `close` only for an agent-created tab. Do not change extension settings without a request. Ask the user to complete credentials, CAPTCHAs or sensitive confirmations; do not bypass authentication.

The older private native `pi-agent-browse` CLI/MCP installation is a separate legacy method with separate pairing state. Do not assume it exists or fall back to it automatically. CDP/Steel remain available when explicitly selected.

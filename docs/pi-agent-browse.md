# Pi Agent Browse

Pi Agent Browse lets Pi operate Chrome in background tabs through a paired extension. It preserves Browser Harness, CDP and Steel as separate, explicitly selectable methods. The extension is an MIT-licensed derivative of [anomalyco/browse](https://github.com/anomalyco/browse), pinned to `4da08c2582786fdbaf2e8c22bcfa59b58899d9db`; the overlay is in `scripts/pi-agent-browse/`. No Chrome Web Store account is required.

## Download and load Chrome

In **Administrative Settings → Pi Agent Browse**, choose **Download ZIP** or **Copy link**. Extract the ZIP to a stable directory. In Chrome, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the folder containing `manifest.json`.

The public `GET /api/browser/pi-agent-browse-extension.zip` route does not require a login. Only this artifact is public: download metadata, Console, pairing, status and revocation require authentication. The archive contains no API token, pairing code or browser credentials. The extension's stable Chrome ID is `heidjicdbehhgidkhaofophkickmhijo`; its origin is checked, but the ID itself is not an authentication credential.

The ZIP is tracked at `assets/browser-downloads/pi-agent-browse-extension.zip` and ships in Git and npm installations. No public origin is necessary for local operation. A loopback download link only works on the computer serving it.

## Local: Pi and Chrome on the same computer

Install Pi and the package on the Chrome computer, using the normal installation flow:

```sh
pi install npm:pi-feats
pi browser pair
```

`pair` starts the shared relay if needed. In extension Settings, choose **Local relay**, enter `127.0.0.1:20087` and the five-minute, single-use code, then click **Connect**. Once Chrome is connected, all local Pi Profiles on this installation can use it immediately. No profile selection or separate authorization is needed. To check the connection:

```sh
pi browser status
pi profile support browser status
```

The same Chrome can serve multiple profiles at the same time. No profile-specific relay, Chrome address change, or additional pairing is required. Each profile can only operate tabs it created on the current connection. Profiles using the same Chrome profile still share cookies and logged-in accounts.

One loopback Node relay runs under the default runtime using private files in `<agent root>/browser-local/shared/`. A named sandbox gets only a profile-specific worker capability. It cannot administer the relay or use another profile's tabs. `pi browser install` starts or updates the daemon while preserving Chrome credentials; `pi browser stop` stops it for all profiles without deleting state. `pi browser unpair` removes every local Chrome pairing. These commands do not modify remote Console pairing.

On first startup, the shared relay attempts to stop previous Pi Node relays through their authenticated local APIs. It does not import their credentials: pair Chrome once at the shared address. If Chrome is already paired with the shared relay, the existing pairing still works after updating it. The existing Chrome extension can be reused. If a standalone native relay or unrelated process occupies port 20087, stop it yourself or free the port; Pi will not kill it. The shared relay's startup log is `browser-local/shared/relay.log`.

## Remote: Pi on another server

The Chrome computer only needs the extension, not Pi or a native/local relay. The extension initiates an outbound WSS connection to the Pi API.

1. Configure `PI_PUBLIC_BASE_URL` (or `api.publicBaseUrl`) to a public HTTPS origin, without a path, query or credentials.
2. Route `/api/browser/pi-agent-browse-extension.zip` to the Pi API or the Console's fixed artifact proxy. Route WebSocket upgrades for `/api/browser/connect` **to the Pi API**. The Console's generic HTTP API proxy does not proxy WebSockets. Use a trusted TLS reverse proxy; do not expose the loopback local relay.
3. Download the extension ZIP from this server. The API embeds only the public WSS endpoint and updates the extension CSP. An old/local-only archive must be re-downloaded and reloaded to gain the configured remote address.
4. In Console → **Pi Agent Browse → Connect Chrome → Pi on another server**, select the Pi Profile and generate a code.
5. On the Chrome computer, choose **Remote server**, check the displayed server address, paste the code and **Connect**.
6. Console shows connected/disconnected browsers. Use **Revoke browser access** to invalidate that profile's credentials and disconnect it immediately.

Only a validated public HTTPS origin enables remote code generation; otherwise Console explains that remote pairing is unavailable while local pairing remains usable. A working HTTPS download alone does not prove the reverse proxy supports WebSocket upgrades.

One browser identity can pair with one profile on the same remote endpoint. Revoke its previous profile pairing before moving it to another profile. The extension switches between endpoints; it does not maintain simultaneous local and remote connections.

## Authentication, isolation and agent access

The server reuses the upstream protocol-3 handshake: short-code PBKDF2 material, ephemeral P-256 ECDH, HMAC transcript proofs, a masked per-browser token, and fresh nonces on reconnection. The branded derivative additionally binds remote proofs and session keys to the complete configured WSS endpoint, rather than only its port; local handshake compatibility remains unchanged. Browser tokens are independent of administrative API credentials. Codes expire after five minutes and are consumed atomically after a matching proof. Pending codes are memory-only and disappear on restart. Failed handshakes are bounded by per-peer rate limits, message/queue limits, a connection limit and a handshake timeout. A shared reverse proxy shares its peer budget; untrusted forwarded headers are not used as identity.

Remote browser credentials persist in each workspace's `browser/credentials.json`. A control-plane key in the default runtime's `browser/signing.key` signs profile association; a sandboxed profile cannot forge another profile's credential record by editing its own file. Linux credential I/O pins the workspace subdirectory and refuses symlinks. The broker owns live connections; named profiles receive only a random, in-memory worker capability and the loopback API endpoint. Worker environment forwarding preserves this dedicated capability through Nono without exposing the administrative API token, disabling the sandbox or granting write access to runtime code. Worker capabilities are regenerated on API startup. A worker capability cannot generate pairing codes, revoke pairings, or select another profile.

The `pi_browser` tool supports status, tab listing, background navigation, accessibility snapshots, reference-based click/fill, keyboard input, scrolling, bounded DOM evaluation, screenshots and closing agent-created tabs. It only operates tabs created by its profile during the current browser connection; existing personal tabs are not automatically adopted, and tabs from an old connection are not reclaimed after reconnect. Use a fresh `snapshot` after a navigation or re-render. For DOM data, prefer bounded `evaluate` results; screenshots are for visual verification. The tool does not replace the existing `browser_*` CDP/Steel tools or silently switch their selected connection.

The extension still requires broad browser permissions. Page data can reach the configured model provider through the agent; local transport does not imply local inference. Authentication prompts, CAPTCHAs and sensitive confirmations require user participation. Pair only browsers and profiles intended for the task.

## Extension builds and legacy native distribution

To rebuild the public ZIP, use Node, Git, Bun, ImageMagick (`convert` or `IMAGEMAGICK=magick`), `tar` and `zip`:

```sh
node scripts/pi-agent-browse/build.mjs /absolute/path/to/browse-checkout /absolute/path/to/new-output --extension-only
```

The build exports the pinned Git object, not checkout modifications. Verify the generated ZIP, then replace the tracked public archive. Keep the MIT notice. No tokens, profile state or pairing codes belong in the archive.

The older native relay build is still available for standalone upstream-compatible CLI/MCP use: omit `--extension-only` and provide Rust/Cargo on the target platform. It is not required by `pi browser` or the remote flow. Private native bundles can still use `stage-private.mjs` with a package marked `"private": true`, installing managed files under `~/pi-feats/browse/{extension,relay}`. Do not stage native private assets into the public package. Legacy pairing and state remain separate from the Node relay.

## Validation and current limits

Automated local tests cover real WebSocket handshake exchanges with an extension-protocol client, profile-bound command routing, persistence, reconnect, revocation, code rejection, worker authorization, signed credential files, and an isolated local daemon/CLI lifecycle. They do not substitute for a Chrome end-to-end test across two machines and a deployed TLS reverse proxy. No remote server is modified or tested without explicit authorization.

Remote API workers automatically receive their profile-bound browser capability. Standalone CLI/TUI sessions use their own local relay; they do not automatically borrow a remote server's administrative credentials. The relay is started on demand, not registered as an OS service or automatically started at login.

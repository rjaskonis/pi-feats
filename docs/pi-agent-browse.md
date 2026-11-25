# Pi Agent Browse

Pi Agent Browse is a privately distributed, MIT-licensed derivative of [browse](https://github.com/anomalyco/browse). The Chrome extension and native relay are built from one pinned upstream commit with the overlay in `scripts/pi-agent-browse/`. The original copyright and license are included in both archives. The extension has its own stable Chrome ID and the private relay accepts only that origin, in addition to requiring browser pairing. The ID is not an authentication credential.

## Build and share

On the target OS and architecture, use Node.js, Git, Bun, Rust/Cargo, ImageMagick (`convert` or set `IMAGEMAGICK=magick`), `tar` and `zip`. The initial dependency build can take several minutes.

```sh
node scripts/pi-agent-browse/build.mjs /absolute/path/to/browse-checkout /absolute/path/to/new-release-directory
```

The script uses the pinned Git object, not any uncommitted files in that checkout. Use a new versioned directory for each release. Share the extension ZIP, the matching relay ZIP for the user's OS and architecture, `SHA256SUMS` and `BUILD.txt` through an authenticated private release or download area. A secret URL alone is shareable by anyone who receives it. Do not include relay state, tokens or pairing codes in release artifacts. This build does not require the Chrome Web Store or the upstream installer.

## Bundle with a private pi-feats distribution

In a private `pi-feats` checkout, set `"private": true` in `package.json` to prevent accidental npm publication. Stage one or more verified platform builds before packaging:

```sh
node scripts/pi-agent-browse/stage-private.mjs /absolute/path/to/browse-release-linux-x64
```

This creates `assets/pi-agent-browse/`. Include that directory in the private package or commit it only in the private Git distribution. Increment the private package version or publish a new private Git revision for each update. Do not copy the staged files into the public distribution.

On supported platforms, the `pi-feats` lifecycle script installs or updates both components in stable locations and prints the extension path:

- Chrome extension: `~/pi-feats/browse/extension`
- Relay command: `~/pi-feats/browse/relay/pi-agent-browse`

No separate download is needed. Identical files are left untouched. On a bundled relay update, the installer restarts a running relay through its authenticated local command; missing relays are started on first use. The installer does not enable Chrome Developer mode, load the extension, or pair the browser on the user's behalf. If already loaded, reload the extension after an update, using the same directory and pairing. The public variant bundles only the downloadable extension ZIP and skips installation of the native relay. A private build with no relay for the current platform reports that limitation.

## Download from the pi-feats API

The tracked `assets/browser-downloads/pi-agent-browse-extension.zip` ships with Git and npm installations. To refresh it, run `scripts/pi-agent-browse/build.mjs` with `--extension-only` and replace the tracked ZIP with the generated archive. Do not add native relay binaries or pairing state to the public package.

In **Administrative Settings → Pi Agent Browse**, use **Copy link** to share the full URL or **Download ZIP**. Anyone with the URL can download the bundled extension at `GET /api/browser/pi-agent-browse-extension.zip` without authentication. Only the ZIP is public; the Console and `/api/browser/download-status` still require authentication. The published HTTPS origin must route the download path to either the Pi API or the Console WebUI.

With `PI_PUBLIC_BASE_URL` (or `api.publicBaseUrl`) set to a public HTTPS origin, the download embeds `wss://<host>/api/browser/connect` and permits that destination in the Chrome extension policy. The Settings pairing form defaults to **Remote server**, shows the configured host and also offers **Local relay**. Without a configured public origin, the Console uses its own origin for the download link and serves the local-only ZIP. A loopback Console link works only on that computer. Rebuild old extension archives before staging them; the API returns `503` for incompatible archives or invalid public origins instead of serving a local ZIP as a remote one.

The ZIP contains no relay, API token or pairing credentials. **Remote relay transport and profile-bound pairing are not implemented yet.** The configured URL is the intended browser WebSocket endpoint, not an active relay route. Local pairing remains available.

## Install and pair

1. With a bundled private `pi-feats` installation, use the stable paths above. For a standalone installation, verify the archive checksums against the authenticated download source, then extract the relay and add its directory to `PATH` or use the absolute executable path. Keep both relay files together. The agent needs access to those files, the isolated relay state directory and loopback if it runs in a sandbox. The supported starting point is a local Pi session; per-profile sandbox access is not configured by this package.
2. Use the bundled stable path, or extract the standalone extension ZIP into a stable path. In the intended Chrome profile, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, then select the directory containing `manifest.json`. Use a profile without personal sessions for initial evaluation.
3. Run `pi-agent-browse pair`. In the extension's **Settings**, choose **Pair with a code** and enter the one-time code. Use `127.0.0.1:20087` if the form asks for the relay address. `pi-agent-browse status` verifies the connection. A first-time installation does not reuse the original OpenCode Browse pairing.
4. Ask Pi to use **Pi Agent Browse** explicitly. The packaged skill uses the local CLI. MCP-capable clients can alternatively connect via stdio with `pi-agent-browse mcp`. No changes are required to the existing Pi Browser Harness, Steel or external CDP configuration.

The listener binds only to loopback. The relay launcher disables the upstream updater and keeps state under `${XDG_STATE_HOME:-$HOME/.local/state}/pi-agent-browse`. The extension still needs broad browser permissions to operate authorized tabs. Page data can reach the configured model provider through the agent; local transport does not guarantee local inference.

## Update or remove

Replace the extension files at the same installation path and reload the extension at `chrome://extensions`. Stop the previous local relay before replacing its executable so that the next invocation starts the matching build. Keep pairing state unless you intend to re-pair. To remove access, revoke the browser with `pi-agent-browse pair --revoke <browser-id>` and remove the extension from Chrome.

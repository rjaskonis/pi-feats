import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const upstream = '4da08c2582786fdbaf2e8c22bcfa59b58899d9db';
export const port = 20087;
const name = 'Pi Agent Browse';
// Public key only. Unpacked installations use it to derive a stable Chrome ID.
const key = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqVMYckIR0y0pMEJCxj3BUO0BjxjnUiHacWxm86kkXJMKsaYkQUl5rNwhx8+EZLFs6zJTsVQnS4hADwd2XLfd+C4mvo30kOiJB7t2Mn6jk9MYu+kuNwQkAjlHXiJKYBwej+vcjYGyKQ08Bw607MH19jAd2WWbmktOWpRC7El/zn5YZ8MXr2n2LA2cfV0M89CPO+pZeqVBoLiWOGgROmKUItAFRSX6croGxroyiFC4kD+8pWYG7o3nHLnoCZOKtFisik/z+CWm8CBzjqVU8EEoad4ryUfJI1tBQf/uXcZCl54VlDHv7wMDXEACoKCx33i16k9/MCoSehWzBehVMHPKIwIDAQAB';
export const extensionId = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  .replace(/./g, digit => String.fromCharCode(97 + parseInt(digit, 16)));

export function brand(root) {
  const read = file => readFileSync(join(root, file), 'utf8');
  const write = (file, value) => writeFileSync(join(root, file), value);
  const replace = (file, from, to) => {
    const text = read(file);
    if (text.split(from).length !== 2) throw new Error(`Unexpected upstream source in ${file}: ${from}`);
    write(file, text.replace(from, () => to));
  };
  const manifest = JSON.parse(read('public/manifest.json'));
  manifest.name = name;
  manifest.version_name = `${manifest.version}-pi.2`;
  manifest.description = 'Lets your Pi agent work in background Chrome tabs and hand control back when needed.';
  manifest.action.default_title = `${name} · Click to let agents use this tab`;
  manifest.key = key;
  manifest.content_security_policy = {
    extension_pages: `script-src 'self'; object-src 'self'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*`,
  };
  write('public/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  replace('src/background/index.ts', 'OpenCode Browse ·', `${name} ·`);
  replace('src/status/ui.tsx', '>browse</span>', `>${name}</span>`);
  replace('src/content/page-status.ts', '${MARK}browse', '${MARK}Pi Agent Browse');
  replace('settings.html', 'Settings · browse', `Settings · ${name}`);
  replace('welcome.html', '<title>browse</title>', `<title>${name}</title>`);
  // The upstream onboarding points to its public installer. This private build uses manual pairing instead.
  write('onboarding.html', `<!doctype html>\n<html lang="en"><meta charset="utf-8"><title>Setup · ${name}</title>\n<h1>${name}</h1><ol><li>Get a pairing code from your platform for a remote server, or run <code>pi browser pair</code> for a local relay.</li>\n<li>Open <a href="settings.html">Settings</a> and choose <strong>Pair with a code</strong>.</li>\n<li>Enter the pairing code and click <strong>Connect</strong>. Choose the configured remote server or the local relay before connecting.</li></ol>\n<p>Install updates from the same private source as this build.</p></html>\n`);
  const status = 'src/status/describe.ts';
  replace(status, 'import { installCommand } from "./install"\n', '');
  replace(status, 'import { unpackedReloadAdvice } from "../../cli/src/protocol"\n', '');
  replace(status, 'describeStatus(state: AgentRelayState, unpacked: boolean)', 'describeStatus(state: AgentRelayState, _unpacked: boolean)');
  const statusText = read(status);
  const start = statusText.indexOf('  if (state.status === "incompatible" &&');
  const end = statusText.indexOf('  if (remote) return', start);
  if (start < 0 || end < 0) throw new Error('Unexpected upstream connection status code');
  write(status, statusText.slice(0, start) + `  if (state.status === "incompatible") return "Install matching Pi Agent Browse extension and relay builds from your private download source."\n  if (state.status === "unpaired" || state.status === "untrusted")\n    return "Run pi browser pair for a local relay, or generate a profile pairing code in Console for a remote server."\n` + statusText.slice(end));
  write('src/shared/pi-relay.ts', `// Replaced in the authenticated server download; inert in local builds.\nconst endpoint = "wss://pi-agent-browse.invalid/api/browser/connect"\nexport const cloudRelay = new URL(endpoint)\nexport const cloudAvailable = cloudRelay.hostname !== "pi-agent-browse.invalid"\nexport const cloudAddress = cloudAvailable ? cloudRelay.hostname + ":" + (cloudRelay.port || "443") : ""\nexport const localAddress = "127.0.0.1:${port}"\n`);
  const discovery = 'src/background/agent-relay/discovery.ts';
  replace(discovery, 'import { defaultRelayPort,', 'import { cloudAddress } from "../../shared/pi-relay"\nimport { defaultRelayPort,');
  replace(discovery, 'relayAddress(stored[RELAY_ADDRESS_KEY])', 'relayAddress(stored[RELAY_ADDRESS_KEY] ?? cloudAddress)');
  const worker = 'src/background/agent-relay.ts';
  replace(worker, 'import { createRelayDiscovery, relayTarget }', 'import { cloudAddress, cloudRelay } from "../shared/pi-relay"\nimport { createRelayDiscovery, relayTarget }');
  replace(worker, 'const url = `ws://${host}:${port}/extension`', 'const address = `${host}:${port}`\n    if (address !== cloudAddress && !/^127\\.0\\.0\\.1:[0-9]{4,5}$/.test(address)) { setStatus("offline"); return }\n    const url = address === cloudAddress ? cloudRelay.href : `ws://${address}/extension`'.replace('${port}', String(port)));
  const handshake = 'src/background/agent-relay/handshake.ts';
  replace(handshake, 'import { defaultRelayPort,', 'import { cloudAddress } from "../../shared/pi-relay"\nimport { defaultRelayPort,');
  replace(handshake, 'port: Number(new URL(current.url).port),', 'port: Number(new URL(current.url).port || (new URL(current.url).protocol === "wss:" ? "443" : "80")),');
  // Bind remote proofs to the full configured WSS endpoint, not just a shared port number.
  const pairing = 'src/background/pairing.ts';
  replace(pairing, 'port: number, ownNonce: string, peerNonce: string)', 'port: number, ownNonce: string, peerNonce: string, endpoint = pairingEndpoint(port))');
  replace(pairing, '${pairingEndpoint(port)}|${peerNonce}', '${endpoint}|${peerNonce}');
  replace(pairing, 'export type HandshakeTranscript = { port: number;', 'export type HandshakeTranscript = { endpoint?: string; port: number;');
  replace(pairing, '${pairingEndpoint(transcript.port)}', '${transcript.endpoint ?? pairingEndpoint(transcript.port)}');
  replace(handshake, 'pending.port, relayNonce, pending.nonce)', 'pending.port, relayNonce, pending.nonce, new URL(current.url).protocol === "wss:" ? current.url : undefined)');
  replace(handshake, 'pending.port, pending.nonce, relayNonce)', 'pending.port, pending.nonce, relayNonce, new URL(current.url).protocol === "wss:" ? current.url : undefined)');
  replace(handshake, 'port: pending.port,', 'port: pending.port,\n          endpoint: new URL(current.url).protocol === "wss:" ? current.url : undefined,');
  replace(handshake, 'const address = relayAddress(addressInput)', `const address = relayAddress(addressInput)\n    if (addressInput !== cloudAddress && !/^127\\.0\\.0\\.1:[0-9]{4,5}$/.test(addressInput)) return { status: "invalid-address" }`);
  replace(handshake, 'const stored = await chrome.storage.local.get([PAIRING_KEY, TOKENS_KEY, SPENT_KEY, CODE_PORT_KEY])', 'const stored = await chrome.storage.local.get([PAIRING_KEY, TOKENS_KEY, SPENT_KEY, CODE_PORT_KEY, "piPairingAddress"])');
  replace(handshake, 'usable(entered, !automatic || port === codePort(stored[CODE_PORT_KEY]))', 'usable(entered, (stored.piPairingAddress === address || (stored.piPairingAddress === undefined && local)) && (!automatic || port === codePort(stored[CODE_PORT_KEY])))');
  replace(handshake, '[CODE_PORT_KEY]: codePort,', '[CODE_PORT_KEY]: codePort,\n              piPairingAddress: `${address.host}:${address.port ?? defaultRelayPort}`,');
  replace(handshake, '(before[RELAY_ADDRESS_KEY] ?? "") !== value', 'before[RELAY_ADDRESS_KEY] !== value');
  replace(handshake, 'const clearDiscovered = scannedOnly', 'const switchRelay = (before[RELAY_ADDRESS_KEY] ?? cloudAddress) !== value\n    const clearDiscovered = scannedOnly');
  replace(handshake, '[RELAY_ADDRESS_KEY]: value,\n        ...(hinted', '[RELAY_ADDRESS_KEY]: value,\n        ...(switchRelay && code === undefined ? { [PAIRING_KEY]: "" } : {}),\n        ...(hinted');
  const form = 'src/status/relay-form.tsx';
  replace(form, 'import { createEffect,', 'import { cloudAddress, cloudAvailable, cloudRelay, localAddress } from "../shared/pi-relay"\nimport { createEffect,');
  replace(form, 'const [address, setAddress] = createSignal("")', 'const [address, setAddress] = createSignal(cloudAvailable ? cloudAddress : localAddress)');
  replace(form, 'setAddress(props.remote && !relay.remote ? "" : relay.address)', 'setAddress(cloudAvailable && relay.address === cloudAddress ? cloudAddress : relay.address || localAddress)');
  replace(form, '    setEdited(false)\n    setPending(true)', '    setPending(true)');
  replace(form, '    setPending(false)\n    setResult(message)', '    setPending(false)\n    setEdited(false)\n    setResult(message)');
  const formText = read(form);
  const fieldStart = formText.indexOf('          <Field.Label>Relay address');
  const fieldEnd = formText.indexOf('        </Field>', fieldStart);
  if (fieldStart < 0 || fieldEnd < 0) throw new Error('Unexpected upstream pairing form');
  write(form, formText.slice(0, fieldStart) + `          <label for="relay-mode">Connect to</label>\n          <select id="relay-mode" value={cloudAvailable && address() === cloudAddress ? "remote" : "local"} disabled={pending()} onChange={(event) => {\n            setEdited(true)\n            setAddress(event.currentTarget.value === "remote" ? cloudAddress : localAddress)\n            setCode("")\n            setResult(undefined)\n          }}>\n            <Show when={cloudAvailable}><option value="remote">Remote server</option></Show>\n            <option value="local">Local relay</option>\n          </select>\n          <Show when={!cloudAvailable || address() !== cloudAddress}><label for="local-address">Local relay address</label><input id="local-address" value={address()} disabled={pending()} onInput={(event) => { setAddress(event.currentTarget.value); setEdited(true) }} placeholder={localAddress} /></Show>\n          <p class="hint">{address() === cloudAddress && cloudAvailable ? cloudRelay.host + " — Generate a profile pairing code in Console → Pi Agent Browse. No local relay required." : "Run pi browser pair on this computer. Use the address and code shown by the CLI."}</p>\n` + formText.slice(fieldEnd));
  replace('src/agent-relay/protocol.ts', 'defaultRelayPort = 19988', `defaultRelayPort = ${port}`);
  replace('src/agent-relay/protocol.ts', '[19990, 19991, 19992, 19993, 19994, 19995, 19996, 19997] as const', '[] as const');
  const origins = 'rust/crates/browse-relay/src/origins.rs';
  const originText = read(origins);
  const next = originText.indexOf('pub fn validate_host_header');
  if (next < 0) throw new Error('Unexpected upstream origin checks');
  write(origins, `use std::collections::HashSet;\n\n/// Only the private unpacked extension may pair.\npub fn allowed_extension_origins() -> HashSet<String> {\n    ["chrome-extension://${extensionId}".into()].into()\n}\n\n` + originText.slice(next));
  const serve = 'rust/crates/browse-relay/src/serve.rs';
  const serveText = read(serve);
  const hostStart = serveText.indexOf('fn relay_host(');
  const hostEnd = serveText.indexOf('/// Binds the relay', hostStart);
  if (hostStart < 0 || hostEnd < 0) throw new Error('Unexpected upstream listener configuration');
  write(serve, serveText.slice(0, hostStart) + serveText.slice(hostEnd));
  replace(serve, 'let host = relay_host(&paths);', 'let host = IpAddr::from([127, 0, 0, 1]);');
  const launcher = 'rust/crates/browse/src/serve.rs';
  replace(launcher, 'auto_update: Some(Arc::new(update::status_json)),', 'auto_update: None,');
  replace(launcher, 'let mut updater = update::Updater::spawn(Arc::new(move || relay.idle(quiet)));', 'let mut updater: Option<update::Updater> = None;');
  replace(launcher, '        let relay = handle.relay.clone();\n', '');
}

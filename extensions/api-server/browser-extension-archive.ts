import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const templateEndpoint = "wss://pi-agent-browse.invalid/api/browser/connect";

export function cloudExtensionArchive(zip: Uint8Array, publicBaseUrl: string): Buffer {
  const url = new URL(publicBaseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !/^[a-z0-9.-]+$/i.test(url.hostname) || /^(localhost|.*\.localhost|127\..*|0\.0\.0\.0)$/i.test(url.hostname) ||
      url.hostname === "pi-agent-browse.invalid") {
    throw new Error("Pi Agent Browse requires a public HTTPS origin in PI_PUBLIC_BASE_URL or api.publicBaseUrl.");
  }
  const origin = `wss://${url.host}`;
  const endpoint = `${origin}/api/browser/connect`;
  const files = unzipSync(zip);
  let patched = 0;
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith(".js")) continue;
    const script = strFromU8(bytes);
    if (!script.includes(templateEndpoint)) continue;
    files[name] = strToU8(script.replaceAll(templateEndpoint, endpoint));
    patched++;
  }
  if (!patched || !files["manifest.json"]) throw new Error("The bundled Pi Agent Browse archive must be rebuilt with cloud download support.");
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  const csp = manifest.content_security_policy?.extension_pages;
  if (typeof csp !== "string" || !csp.includes("connect-src ")) throw new Error("Missing extension connection policy.");
  manifest.content_security_policy.extension_pages = csp.replace(/(^|;\s*)connect-src ([^;]+)/, `$1connect-src $2 ${origin}`);
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2) + "\n");
  return Buffer.from(zipSync(files));
}

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { browserApiOrigin, cloudExtensionArchive } from "../extensions/api-server/browser-extension-archive.ts";
import { registerBrowserDownload } from "../extensions/api-server/browser-download.ts";

test("only the ZIP download is public; metadata requires authorization", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-browser-download-"));
  const archive = join(directory, "extension.zip");
  const endpoint = "wss://pi-agent-browse.invalid/api/browser/connect";
  const manifest = { content_security_policy: { extension_pages: "connect-src 'self'" } };
  const zip = zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)), "background.js": strToU8(endpoint) });
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(directory, { force: true, recursive: true }); });
  registerBrowserDownload(app, (request, reply) => {
    if (request.headers.authorization === "Bearer test-token") return true;
    void reply.code(401).send();
    return false;
  }, { source: pathToFileURL(archive), publicBaseUrl: "https://pi.example.test" });
  const request = { method: "GET" as const, url: "/api/browser/pi-agent-browse-extension.zip" };
  const metadata = { method: "GET" as const, url: "/api/browser/download-status" };
  const headers = { authorization: "Bearer test-token" };
  assert.equal((await app.inject(request)).statusCode, 404);
  assert.equal((await app.inject(metadata)).statusCode, 401);
  assert.equal((await app.inject({ ...metadata, headers })).json().available, false);
  await writeFile(archive, zip);
  const response = await app.inject(request);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/zip");
  assert.equal(response.headers["content-disposition"], 'attachment; filename="pi-agent-browse-extension.zip"');
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(strFromU8(unzipSync(response.rawPayload)["background.js"]), "wss://pi.example.test/api/browser/connect");
  assert.deepEqual((await app.inject({ ...metadata, headers })).json(), { available: true, url: "https://pi.example.test/api/browser/pi-agent-browse-extension.zip" });
});

test("the shipped archive downloads without public URL configuration and supports HTTPS customization", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  registerBrowserDownload(app, () => true);
  const url = "/api/browser/pi-agent-browse-extension.zip";
  const response = await app.inject(url);
  assert.equal(response.statusCode, 200);
  const files = unzipSync(response.rawPayload);
  assert.equal(JSON.parse(strFromU8(files["manifest.json"])).name, "Pi Agent Browse");
  assert.ok(files.LICENSE);
  assert.deepEqual((await app.inject("/api/browser/download-status")).json(), { available: true, url });
  const cloud = unzipSync(cloudExtensionArchive(response.rawPayload, "https://pi.example.test"));
  assert.match(strFromU8(cloud["manifest.json"]), /wss:\/\/pi\.example\.test/);
});

test("local Console downloads embed the direct loopback API WebSocket", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const loopback = browserApiOrigin("http://localhost:3030", 8767);
  assert.equal(loopback?.origin, "http://127.0.0.1:8767");
  assert.equal(browserApiOrigin(undefined, 8767)?.origin, loopback?.origin);
  assert.equal(browserApiOrigin("http://127.0.0.1:3030", 8767)?.origin, loopback?.origin);
  assert.equal(browserApiOrigin("http://pi.example.test:3030", 8767), undefined);
  assert.equal(browserApiOrigin("https://pi.example.test:8443", 8767)?.origin, "https://pi.example.test:8443");
  registerBrowserDownload(app, () => true, { relayOrigin: loopback });
  const url = "/api/browser/pi-agent-browse-extension.zip";
  const response = await app.inject(url);
  assert.equal(response.statusCode, 200);
  const files = unzipSync(response.rawPayload);
  const scripts = Object.entries(files).filter(([name]) => name.endsWith(".js")).map(([, data]) => strFromU8(data)).join("\n");
  assert.match(scripts, /ws:\/\/127\.0\.0\.1:8767\/api\/browser\/connect/);
  assert.match(scripts, /Local Console/);
  assert.match(strFromU8(files["manifest.json"]), /ws:\/\/127\.0\.0\.1:8767/);
  assert.deepEqual((await app.inject("/api/browser/download-status")).json(), { available: true, url });
});

test("a configured API download embeds only the public secure relay address", () => {
  const endpoint = "wss://pi-agent-browse.invalid/api/browser/connect";
  const manifest = { key: "stable-id", content_security_policy: { extension_pages: "script-src 'self'; connect-src 'self' ws://127.0.0.1:20087" } };
  const template = zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)), "background.js": strToU8(endpoint), "settings.js": strToU8(endpoint) });
  const result = unzipSync(cloudExtensionArchive(template, "https://pi.example.test:8443/"));
  assert.equal(strFromU8(result["background.js"]), "wss://pi.example.test:8443/api/browser/connect");
  assert.equal(strFromU8(result["settings.js"]), strFromU8(result["background.js"]));
  assert.deepEqual(JSON.parse(strFromU8(result["manifest.json"])), {
    ...manifest, content_security_policy: { extension_pages: `${manifest.content_security_policy.extension_pages} wss://pi.example.test:8443` },
  });
  for (const invalid of ["http://pi.example.test", "https://localhost", "https://user:pass@pi.example.test/", "https://pi.example.test/?code=1234"]) {
    assert.throws(() => cloudExtensionArchive(template, invalid), /public HTTPS origin/);
  }
});

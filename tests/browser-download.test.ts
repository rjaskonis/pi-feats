import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { cloudExtensionArchive } from "../extensions/api-server/browser-extension-archive.ts";
import { registerBrowserDownload } from "../extensions/api-server/browser-download.ts";

test("the extension download requires authorization and returns only the bundled ZIP", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-browser-download-"));
  const archive = join(directory, "extension.zip");
  const zip = Buffer.from("504b0506000000000000000000000000000000000000", "hex");
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(directory, { force: true, recursive: true }); });
  registerBrowserDownload(app, (request, reply) => {
    if (request.headers.authorization === "Bearer test-token") return true;
    void reply.code(401).send();
    return false;
  }, { source: pathToFileURL(archive) });
  const request = { method: "GET" as const, url: "/api/browser/pi-agent-browse-extension.zip" };
  const headers = { authorization: "Bearer test-token" };
  assert.equal((await app.inject(request)).statusCode, 401);
  assert.equal((await app.inject({ ...request, headers })).statusCode, 404);
  await writeFile(archive, zip);
  assert.equal((await app.inject(request)).statusCode, 401);
  const response = await app.inject({ ...request, headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/zip");
  assert.equal(response.headers["content-disposition"], 'attachment; filename="pi-agent-browse-extension.zip"');
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.rawPayload, zip);
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

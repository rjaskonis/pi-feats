import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserStatusGuidance } from "../extensions/pi-agent-browse/guidance.ts";
import { executeBrowserAction } from "../extensions/pi-agent-browse/client.ts";

test("a disconnected saved browser gets actionable local pairing guidance, not a success claim", () => {
  const result = browserStatusGuidance({ browsers: [{ connected: false }] }, "local");
  assert.equal(result.connectionState, "paired_disconnected");
  assert.equal(result.setup.nextStep, "check_chrome_connection");
  assert.match(result.setup.instruction, /already paired but offline/);
  assert.match(result.setup.extensionSettingsUrl, /^chrome-extension:\/\/heidjicdbehhgidkhaofophkickmhijo\/settings.html$/);
});

test("an existing shared pairing without a grant does not prompt another pairing", () => {
  const result = browserStatusGuidance({ browsers: [], sharedBrowserPaired: true, profileAuthorized: false }, "local");
  assert.equal(result.connectionState, "profile_not_authorized");
  assert.equal(result.setup.nextStep, "grant_profile_access");
  assert.match(result.setup.instruction, /pi browser grant/);
});

test("connected browsers are ready and do not request new pairing", () => {
  for (const mode of ["local", "console"] as const) {
    const result = browserStatusGuidance({ browsers: [{ connected: true }, { connected: false }] }, mode);
    assert.equal(result.connectionState, "connected");
    assert.equal(result.setup.nextStep, "ready");
    assert.match(result.setup.instruction, /without pairing again/);
  }
});

test("server context always directs to Console instead of a server-local pairing code", () => {
  const result = browserStatusGuidance({ browsers: [] }, "console");
  assert.equal(result.connectionState, "not_paired");
  assert.equal(result.setup.nextStep, "open_console_pairing");
  assert.match(result.setup.instruction, /Do not generate a loopback pairing code/);
  const unavailable = browserStatusGuidance({ browsers: [], available: false }, "console");
  assert.equal(unavailable.setup.nextStep, "administrator_setup_required");
});

test("first-use status explains setup without leaking missing-file errors or starting a relay", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-browser-guidance-"));
  try {
    const result = await executeBrowserAction(root, { action: "status" }, undefined, {});
    assert.equal(result.connectionState, "relay_not_running");
    assert.equal(result.setup.mode, "local");
    assert.equal(result.setup.nextStep, "generate_local_pairing_code");
    assert.deepEqual(await readdir(root), []);
    await mkdir(join(root, "browser-local", "shared"), { recursive: true });
    await writeFile(join(root, "browser-local", "shared", "shared.key"), "invalid key");
    await assert.rejects(executeBrowserAction(root, { action: "status" }, undefined, {}), /Invalid shared browser relay key/);
    await assert.rejects(executeBrowserAction(root, { action: "status" }, undefined, { PI_BROWSER_ENDPOINT: "http://127.0.0.1:8767" }), /Incomplete browser worker capability/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

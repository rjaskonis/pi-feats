import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { browserConnection } from "../extensions/pi-agent-browse/client.ts";
import { profileBrowserCredentials } from "../extensions/pi-agent-browse/credential-store.ts";

const exec = promisify(execFile);
test("local Node relay CLI installs, pairs, restarts, preserves state and stops inside a profile", { timeout: 40_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-browser-cli-"));
  const profile = `test-${process.pid}`;
  const directory = join(root, "profiles", profile);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "settings.json"), "{}");
  const script = `const jiti = require('jiti').createJiti(process.cwd() + '/package.json'); jiti.import('./extensions/pi-agent-browse/cli.ts').then(m => m.handleBrowserCli(['browser',process.argv[1]],process.argv[2],process.argv[3])).catch(e=>{console.error(e);process.exit(1)})`;
  const run = (action: string) => exec(process.execPath, ["-e", script, action, profile, root], { cwd: resolve("."), timeout: 15_000 });
  try {
    assert.match((await run("install")).stdout, /Browser relay ready/);
    const connection = await browserConnection(directory, {});
    const state = JSON.parse(await readFile(join(directory, "browser-local", "connection.json"), "utf8"));
    assert.equal(state.profile, profile);
    assert.match(state.runtimeVersion, /^[a-f0-9]{64}$/);
    assert.match((await run("pair")).stdout, /Pairing code: [A-Z0-9]{4}-[A-Z0-9]{4}/);
    assert.match((await run("status")).stdout, /"available": true/);
    assert.match((await run("unpair")).stdout, /revoked/);
    assert.match((await run("stop")).stdout, /stopping/);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.match((await run("install")).stdout, /Browser relay ready/);
    assert.equal((await browserConnection(directory, {})).token, connection.token);
    for (const forbidden of ["packages", "extensions", "git", "npm", "node_modules"]) {
      await assert.rejects(stat(join(directory, forbidden)), { code: "ENOENT" });
    }
    assert.deepEqual(JSON.parse(await readFile(join(directory, "settings.json"), "utf8")), {});
  } finally {
    await run("stop").catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 300));
    await rm(root, { recursive: true, force: true });
  }
});

test("profile credential files are signed and do not accept cross-profile edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-browser-store-"));
  const directory = (profile: string) => profile === "default" ? root : join(root, "profiles", profile);
  const profiles = async () => [{ name: "default" }, { name: "support" }];
  try {
    const store = await profileBrowserCredentials(root, profiles, directory);
    await store.save([{ profile: "support", browser: "browser", token: "a".repeat(43) }]);
    assert.equal((await store.load() as any[])[0].profile, "support");
    const file = join(directory("support"), "browser", "credentials.json");
    const value = JSON.parse(await readFile(file, "utf8"));
    value.credentials[0].profile = "default";
    await writeFile(file, JSON.stringify(value));
    assert.deepEqual(await store.load(), []);
    if (process.platform !== "win32") {
      const outside = join(root, "unrelated");
      await mkdir(outside);
      await writeFile(join(outside, "credentials.json"), "do not overwrite");
      const folder = join(directory("support"), "browser");
      await rm(folder, { recursive: true });
      await symlink(outside, folder, "dir");
      await assert.rejects(store.save([{ profile: "support", browser: "browser", token: "a".repeat(43) }]), /symlink/);
      assert.equal(await readFile(join(outside, "credentials.json"), "utf8"), "do not overwrite");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

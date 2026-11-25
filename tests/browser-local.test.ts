import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileBrowserCredentials } from "../extensions/pi-agent-browse/credential-store.ts";

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

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillSourceStore } from "../extensions/skill-sources/store.ts";

function git(cwd: string, ...args: string[]): void { execFileSync("git", args, { cwd, stdio: "ignore" }); }

async function skill(directory: string, name: string, body: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill\n---\n\n${body}\n`);
}

test("publishing an existing Skill requires confirmation and updates its original repository path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-skill-source-"));
  try {
    const work = join(directory, "work"), remote = join(directory, "remote.git"), agent = join(directory, "agent"), local = join(directory, "local-skill");
    await mkdir(work, { recursive: true });
    git(work, "init", "--initial-branch=main");
    git(work, "config", "user.name", "Test User");
    git(work, "config", "user.email", "test@example.com");
    await skill(join(work, "skills", "legacy-path"), "existing-skill", "remote version");
    git(work, "add", ".");
    git(work, "commit", "-m", "Add existing skill");
    git(directory, "init", "--bare", remote);
    git(work, "remote", "add", "origin", remote);
    git(work, "push", "origin", "main");
    await skill(local, "existing-skill", "local version");

    const store = new SkillSourceStore(agent);
    store.save({ identifier: "test-source", name: "Test Source", repoUrl: remote, branch: "main", basePath: "skills", accessToken: "test" });
    assert.equal((await store.sync("test-source")).status, "succeeded");

    const pending = await store.publish("test-source", "default", "existing-skill", local);
    assert.equal(pending.action, "confirmation_required");
    assert.equal(pending.relativePath, "skills/legacy-path");
    assert.match(await readFile(join(local, "SKILL.md"), "utf8"), /local version/);

    const published = await store.publish("test-source", "default", "existing-skill", local, true);
    assert.equal(published.action, "updated");
    const verify = join(directory, "verify");
    git(directory, "clone", "--branch", "main", remote, verify);
    assert.match(await readFile(join(verify, "skills", "legacy-path", "SKILL.md"), "utf8"), /local version/);
    await assert.rejects(readFile(join(verify, "skills", "existing-skill", "SKILL.md"), "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activeBuiltinTools, updatedBuiltinTools } from "../extensions/lib/builtin-tools.ts";
import { ProfileStore } from "../extensions/api-server/profile-store.ts";
import { skillRows } from "../extensions/cli-resources.ts";
import { resolveRootAgentDir, rootRuntimeSources, sharedResources } from "../extensions/profiles.ts";

test("profile root uses the remote agent directory when no reexec root is set", () => {
  assert.equal(resolveRootAgentDir({ PI_CODING_AGENT_DIR: "/home/rj/.pi/agent" }), "/home/rj/.pi/agent");
  assert.equal(resolveRootAgentDir({ PI_CODING_AGENT_DIR: "/home/rj/.pi/agent", PI_PROFILE_ROOT: "/tmp/profile-root" }), "/tmp/profile-root");
});

test("profile metadata is listed and can be updated without changing policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-metadata-test-"));
  try {
    await mkdir(join(root, "profiles", "support"), { recursive: true });
    await writeFile(join(root, "profiles", "support", "settings.json"), JSON.stringify({ profile: { enabledTools: ["read"], description: "Customer support", tags: ["Support", "priority"] } }));
    const store = new ProfileStore(root);
    const listed = await store.list();
    assert.deepEqual(listed.find((profile) => profile.name === "support"), { name: "support", path: join(root, "profiles", "support"), description: "Customer support", tags: ["Support", "priority"] });
    const updated = await store.updateMetadata("support", { description: "Escalation desk", tags: ["Priority", "priority", " on-call "] });
    assert.deepEqual(updated.tags, ["priority", "on-call"]);
    const settings = await store.readSettings("support");
    assert.deepEqual(settings.profile?.enabledTools, ["read"]);
    assert.equal(settings.profile?.description, "Escalation desk");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cloned profiles copy profile configuration and credentials without state", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-clone-test-"));
  const source = join(root, "profiles", "source");
  try {
    await mkdir(join(source, "skills", "source-skill"), { recursive: true });
    await mkdir(join(source, "sessions"), { recursive: true });
    await mkdir(join(source, "context-memory"), { recursive: true });
    await writeFile(join(root, "models.json"), "{\"providers\":{}}\n");
    await writeFile(join(source, "settings.json"), JSON.stringify({ packages: ["npm:never-copy"], extensions: ["never-copy"], profile: { enabledTools: ["read"], enabledSkills: ["*"], enabledProfileSkills: ["*"], skillSources: { shared: true, profile: true }, contextMemory: { mode: "file", target: "profile" }, description: "Source", tags: ["source"] } }));
    await writeFile(join(source, "SOUL.md"), "Source soul\n");
    await writeFile(join(source, "REFINE.md"), "Source refine\n");
    await writeFile(join(source, "guardrails.json"), "{\n  \"guardrails\": []\n}\n");
    await writeFile(join(source, ".env"), "SOURCE_SECRET=value\n");
    await writeFile(join(source, "auth.json"), "{\"source\":true}\n");
    await writeFile(join(source, "skills", "source-skill", "SKILL.md"), "---\nname: source-skill\n---\n");
    await writeFile(join(source, "sessions", "session.jsonl"), "must not copy\n");
    await writeFile(join(source, "context-memory", "PROFILE.md"), "must not copy\n");
    await writeFile(join(source, "application-sessions.json"), "{}\n");
    await writeFile(join(source, "sequential-workflow.db"), "must not copy\n");

    const created = await new ProfileStore(root).create("target", { description: "Target", tags: ["clone"] }, "source");
    assert.equal(created.name, "target");
    const target = join(root, "profiles", "target");
    const settings = JSON.parse(await readFile(join(target, "settings.json"), "utf8"));
    assert.equal(settings.profile.description, "Target");
    assert.deepEqual(settings.profile.tags, ["clone"]);
    assert.deepEqual(settings.profile.contextMemory, { mode: "file", target: "profile" });
    assert.equal(settings.packages, undefined);
    assert.equal(settings.extensions, undefined);
    assert.equal(await readFile(join(target, "SOUL.md"), "utf8"), "Source soul\n");
    assert.equal(await readFile(join(target, ".env"), "utf8"), "SOURCE_SECRET=value\n");
    assert.equal(await readFile(join(target, "auth.json"), "utf8"), "{\"source\":true}\n");
    assert.equal(await readFile(join(target, "skills", "source-skill", "SKILL.md"), "utf8"), "---\nname: source-skill\n---\n");
    assert.equal(await readlink(join(target, "models.json")), join(root, "models.json"));
    for (const file of [join(target, "sessions", "session.jsonl"), join(target, "context-memory", "PROFILE.md"), join(target, "application-sessions.json"), join(target, "sequential-workflow.db")]) assert.equal(existsSync(file), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile Skills use enabledProfileSkills when listed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-resources-test-"));
  const sharedSkills = join(root, "skills");
  const profileSkills = join(root, "profiles", "renne-jaskonis", "skills");
  try {
    for (const name of ["aquanext-account-info", "aquanext-account-activity"]) {
      await mkdir(join(profileSkills, name), { recursive: true });
      await writeFile(join(profileSkills, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    const rows = await skillRows(
      [sharedSkills, profileSkills],
      sharedSkills,
      profileSkills,
      { profile: { enabledSkills: [], enabledProfileSkills: ["aquanext-account-info", "aquanext-account-activity"] } },
      [],
    );
    assert.deepEqual(rows.map(([name, status]) => [name, status]), [
      ["aquanext-account-activity", "enabled"],
      ["aquanext-account-info", "enabled"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("builtin tools default to Pi's four active tools and persist optional tool changes", () => {
  assert.deepEqual(activeBuiltinTools({}), ["read", "bash", "edit", "write"]);
  assert.deepEqual(updatedBuiltinTools({}, "ls", true), ["read", "bash", "edit", "write", "ls"]);
  assert.equal(updatedBuiltinTools({ defaultTools: ["read", "bash", "edit", "write", "ls"] }, "ls", false), undefined);
});

test("default profile tool resources use defaultTools instead of reporting every builtin active", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-tools-test-"));
  try {
    const store = new ProfileStore(root);
    const initial = await store.resources("default", "tools");
    assert.equal(initial.find((tool) => tool.name === "read")?.enabled, true);
    assert.equal(initial.find((tool) => tool.name === "ls")?.enabled, false);
    assert.equal(initial.find((tool) => tool.name === "ls")?.source, "builtin");

    await store.setResource("default", "tools", "ls", true);
    const enabled = await store.resources("default", "tools");
    assert.equal(enabled.find((tool) => tool.name === "ls")?.enabled, true);
    assert.deepEqual((await store.readSettings("default")).defaultTools, ["read", "bash", "edit", "write", "ls"]);

    await store.setResource("default", "tools", "ls", false);
    assert.equal((await store.readSettings("default")).defaultTools, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile tool resources never attribute builtins from a package tool catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-tool-sources-test-"));
  try {
    const packageDir = join(root, "npm", "node_modules", "test-tools");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(root, "settings.json"), JSON.stringify({ packages: ["npm:test-tools"] }));
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "test-tools", pi: { extensions: ["./extension.ts"] } }));
    await writeFile(join(packageDir, "extension.ts"), "const TOOL_NAMES = { native: \"ls\", custom: \"test_tool\" };\n");

    const resources = await new ProfileStore(root).resources("default", "tools");
    assert.equal(resources.filter((tool) => tool.name === "ls").length, 1);
    assert.equal(resources.find((tool) => tool.name === "ls")?.source, "builtin");
    assert.equal(resources.find((tool) => tool.name === "test_tool")?.package, "test-tools");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("named profiles materialize skills declared by enabled packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-package-skills-test-"));
  try {
    const packageDir = join(root, "npm", "node_modules", "test-skills");
    await mkdir(join(packageDir, "skills", "profile-ssh"), { recursive: true });
    await writeFile(join(root, "settings.json"), JSON.stringify({ packages: ["npm:test-skills"] }));
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "test-skills", pi: { skills: ["./skills"] } }));
    await writeFile(join(packageDir, "skills", "profile-ssh", "SKILL.md"), "---\nname: profile-ssh\ndescription: Test skill\n---\n");

    const resources = await sharedResources(root, { enabledSkills: ["*"], skillSources: { shared: true } });
    assert.ok(resources.skills.includes(join(packageDir, "skills")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conversation search is a required runtime extension for named profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-runtime-sources-test-"));
  try {
    await mkdir(join(root, "extensions", "conversation-search"), { recursive: true });
    await writeFile(join(root, "extensions", "conversation-search", "index.ts"), "export default () => {};\n");
    const sources = await rootRuntimeSources(root, { profile: { enabledExtensions: ["profiles"] } });
    assert.deepEqual(sources, [join(root, "extensions", "conversation-search")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activeBuiltinTools, updatedBuiltinTools } from "../extensions/lib/builtin-tools.ts";
import { ProfileStore } from "../extensions/api-server/profile-store.ts";
import { skillRows } from "../extensions/cli-resources.ts";
import { rootRuntimeSources, sharedResources } from "../extensions/profiles.ts";

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

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extensionCatalog, resolveExtension, updatedExtensionSettings } from "../extensions/lib/extension-catalog.ts";
import { findResource } from "../extensions/cli-resources.ts";
import { ProfileStore } from "../extensions/api-server/profile-store.ts";
import { rootRuntimeSources } from "../extensions/profiles.ts";

async function localEntry(root: string, directory: string, name: string, entry = "dist/pi.js") {
  const base = join(root, directory), path = join(base, entry);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(join(base, "package.json"), JSON.stringify({ name }));
  // Discovery must not execute this code.
  await writeFile(path, "throw new Error('Extension code must not run during discovery');\n");
  return path;
}

test("local Hindsight identity, aliases, CLI resolution and API toggles share one catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-catalog-"));
  try {
    const path = await localEntry(root, "hindsight", "@vectorize-io/hindsight-coding-agents");
    const settings = { extensions: [path], customSetting: "preserved" };
    await writeFile(join(root, "settings.json"), JSON.stringify(settings));
    const catalog = await extensionCatalog(root, settings);
    const entry = catalog[0];
    assert.equal(entry.name, "hindsight-coding-agents");
    for (const name of [entry.name, "@vectorize-io/hindsight-coding-agents", "pi", path]) {
      assert.equal(resolveExtension(catalog, name)?.path, path);
      assert.equal(await findResource("extensions", name, settings, root, root), path);
    }
    const store = new ProfileStore(root);
    assert.equal((await store.resources("default", "extensions"))[0].name, entry.name);
    assert.equal((await store.setResource("default", "extensions", entry.name, false)).enabled, false);
    const disabled = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    assert.ok(disabled.extensions.includes(path));
    assert.ok(disabled.extensions.includes(`-${path}`));
    assert.equal(disabled.customSetting, "preserved");
    assert.deepEqual(await rootRuntimeSources(root, disabled), []);
    assert.deepEqual(updatedExtensionSettings(disabled, path, entry, false), disabled);
    assert.equal((await store.setResource("default", "extensions", "@vectorize-io/hindsight-coding-agents", true)).enabled, true);
    const enabled = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    assert.deepEqual(enabled.extensions, [path]);
    assert.deepEqual(await rootRuntimeSources(root, enabled), [path]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("generic entrypoints use package identity while clear multi-extension names survive", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-catalog-"));
  try {
    const paths = await Promise.all(["index.ts", "pi.js", "dist/index.js"].map((entry, index) => localEntry(root, `local-${index}`, `package-${index}`, entry)));
    const base = join(root, "npm", "node_modules", "tools");
    await mkdir(join(base, "dist"), { recursive: true });
    await writeFile(join(base, "package.json"), JSON.stringify({ name: "tools", pi: { extensions: ["dist", "browser.ts", "guard.ts"] } }));
    for (const path of ["dist/index.js", "browser.ts", "guard.ts"]) await writeFile(join(base, path), "export default () => {};\n");
    const catalog = await extensionCatalog(root, { packages: ["npm:tools"], extensions: paths });
    assert.deepEqual(catalog.map((entry) => entry.name), ["browser", "guard", "package-0", "package-1", "package-2", "tools"]);
    assert.equal(resolveExtension(catalog, "dist")?.name, "tools");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ambiguous local aliases never select the first match and canonical names remain usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-catalog-"));
  try {
    const a = await localEntry(root, "a", "@one/memory"), b = await localEntry(root, "b", "@two/memory");
    const settings = { extensions: [a, b] }, catalog = await extensionCatalog(root, settings);
    assert.throws(() => resolveExtension(catalog, "pi"), /ambiguous/);
    assert.throws(() => resolveExtension(catalog, "memory"), /ambiguous/);
    await assert.rejects(findResource("extensions", "pi", settings, root, root), /ambiguous/);
    for (const entry of catalog) assert.equal(resolveExtension(catalog, entry.name)?.path, entry.path);
    assert.equal(resolveExtension(catalog, "@one/memory")?.path, a);
    const legacy = { ...settings, profile: { enabledExtensions: ["pi"] } };
    const first = catalog.find((entry) => entry.path === a)!;
    const disabled = updatedExtensionSettings(legacy, a, first, false, root, catalog);
    const migrated = await extensionCatalog(root, disabled);
    assert.equal(migrated.find((entry) => entry.path === a)?.enabled, false);
    assert.equal(migrated.find((entry) => entry.path === b)?.enabled, true);
    const standalone = join(root, "pi.js");
    await writeFile(standalone, "export default () => {};\n");
    const withAliasCollision = await extensionCatalog(root, { extensions: [a, standalone] });
    assert.equal(withAliasCollision.find((entry) => entry.path === standalone)?.name, standalone);
    for (const entry of withAliasCollision) assert.equal(resolveExtension(withAliasCollision, entry.name)?.path, entry.path);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("automatic extensions remain listed alongside explicit paths and obey exact exclusions", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-catalog-"));
  try {
    await mkdir(join(root, "extensions"));
    const automatic = join(root, "extensions", "custom.ts");
    await writeFile(automatic, "export default () => {};\n");
    const local = await localEntry(root, "local", "memory");
    const settings = { extensions: [local, "-extensions/custom.ts"] };
    const catalog = await extensionCatalog(root, settings);
    assert.equal(catalog.length, 2);
    const automaticEntry = resolveExtension(catalog, "custom")!;
    assert.equal(automaticEntry.enabled, false);
    assert.deepEqual(await rootRuntimeSources(root, settings), [local]);
    const enabled = updatedExtensionSettings(settings, automatic, automaticEntry, true, root);
    assert.ok((await extensionCatalog(root, enabled)).find((entry) => entry.path === automatic)?.enabled);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("required runtime extensions reject disabling and explicit legacy exclusions are not bypassed", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-catalog-"));
  try {
    await mkdir(join(root, "extensions"));
    const path = join(root, "extensions", "profiles.ts");
    await writeFile(path, "export default () => {};\n");
    const entry = (await extensionCatalog(root, {}))[0];
    assert.throws(() => updatedExtensionSettings({}, path, entry, false), /required/);
    assert.deepEqual(await rootRuntimeSources(root, { profile: { enabledExtensions: [] } }), [path]);
    assert.deepEqual(await rootRuntimeSources(root, { extensions: [`-${path}`], profile: { enabledExtensions: [] } }), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("package glob declarations and object resource filters are respected by profile injection", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-catalog-"));
  try {
    const base = join(root, "npm", "node_modules", "tools");
    await mkdir(join(base, "extensions"), { recursive: true });
    await writeFile(join(base, "package.json"), JSON.stringify({ name: "tools", pi: { extensions: ["extensions/*.ts", "!extensions/legacy.ts"] } }));
    for (const name of ["alpha", "beta", "legacy"]) await writeFile(join(base, "extensions", `${name}.ts`), "export default () => {};\n");
    const settings = { packages: [{ source: "npm:tools", extensions: ["extensions/*.ts", "!extensions/beta.ts"] }] };
    const catalog = await extensionCatalog(root, settings);
    assert.equal(resolveExtension(catalog, "alpha")?.enabled, true);
    assert.equal(resolveExtension(catalog, "beta")?.enabled, false);
    assert.equal(resolveExtension(catalog, "legacy"), undefined);
    assert.deepEqual(await rootRuntimeSources(root, settings), [join(base, "extensions", "alpha.ts")]);
    const beta = resolveExtension(catalog, "beta")!;
    const enabled = updatedExtensionSettings(settings, beta.path, beta, true, root);
    assert.equal(resolveExtension(await extensionCatalog(root, enabled), "beta")?.enabled, true);
    assert.deepEqual(await rootRuntimeSources(root, { packages: [{ source: "npm:tools", extensions: [] }] }), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("toggling an extension from a named profile only changes the root runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-catalog-"));
  try {
    const path = await localEntry(root, "local", "memory");
    await mkdir(join(root, "profiles", "support"), { recursive: true });
    await writeFile(join(root, "settings.json"), JSON.stringify({ extensions: [path] }));
    await writeFile(join(root, "profiles", "support", "settings.json"), JSON.stringify({ profile: { enabledSkills: [] } }));
    const before = await readFile(join(root, "profiles", "support", "settings.json"), "utf8");
    const store = new ProfileStore(root);
    assert.equal((await store.setResource("support", "extensions", "memory", false)).enabled, false);
    assert.equal(await readFile(join(root, "profiles", "support", "settings.json"), "utf8"), before);
    const settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    assert.deepEqual(await rootRuntimeSources(root, settings), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

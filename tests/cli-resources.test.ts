import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { skillRows } from "../extensions/cli-resources.ts";
import { rootRuntimeSources } from "../extensions/profiles.ts";

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

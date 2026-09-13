import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDefaultProfileContextMemory, normalizeIdentity, resolveContextMemory, updateContextMemory } from "../extensions/lib/context-memory.ts";

test("new profiles default Context Memory to PROFILE.md without replacing an existing choice", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-memory-"));
  try {
    const profile = join(root, "profile"); await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "settings.json"), JSON.stringify({ profile: { model: "test" } }));
    await ensureDefaultProfileContextMemory(profile);
    assert.deepEqual(JSON.parse(await readFile(join(profile, "settings.json"), "utf8")).profile.contextMemory, { mode: "file", target: "profile" });
    await writeFile(join(profile, "settings.json"), JSON.stringify({ profile: { contextMemory: { mode: "file", target: "identity" } } }));
    await ensureDefaultProfileContextMemory(profile);
    assert.deepEqual(JSON.parse(await readFile(join(profile, "settings.json"), "utf8")).profile.contextMemory, { mode: "file", target: "identity" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("identity paths are deterministic and do not expose the raw identity", () => {
  const value = normalizeIdentity("5519996034196@s.whatsapp.net");
  assert.equal(value, normalizeIdentity("5519996034196@s.whatsapp.net"));
  assert.match(value, /-[a-f0-9]{12}$/);
  assert.ok(!value.includes("@"));
});

test("identity mode has no fallback to PROFILE.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-memory-"));
  try {
    const profile = join(root, "profiles", "support");
    await mkdir(join(profile, "context-memory"), { recursive: true });
    await writeFile(join(profile, "settings.json"), JSON.stringify({ profile: { contextMemory: { mode: "file", target: "identity" } } }));
    await writeFile(join(profile, "context-memory", "OPERATIONAL.md"), "Operational fact");
    await writeFile(join(profile, "context-memory", "PROFILE.md"), "Must not leak");
    const memory = await resolveContextMemory(root, profile, { application: "assistant", identityKey: "person@example.com", profile: "support" });
    assert.equal(memory.operational, "Operational fact");
    assert.equal(memory.personal, "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("updates are isolated to the current identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-memory-"));
  try {
    const profile = join(root, "profiles", "support");
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "settings.json"), JSON.stringify({ profile: { contextMemory: { mode: "file", target: "identity" } } }));
    await updateContextMemory(root, profile, { application: "assistant", identityKey: "a@example.com", profile: "support" }, "insert", "user", "Prefers Portuguese");
    const other = await resolveContextMemory(root, profile, { application: "assistant", identityKey: "b@example.com", profile: "support" });
    assert.equal(other.personal, "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("enforces character limits before writing Context Memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-memory-"));
  try {
    const profile = join(root, "profiles", "support");
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "settings.json"), JSON.stringify({ profile: { contextMemory: { mode: "file", target: "profile" } } }));
    const context = { profile: "support" };
    const exact = await updateContextMemory(root, profile, context, "replace", "profile", "a".repeat(1375));
    assert.equal(exact.used, 1375);
    await assert.rejects(() => updateContextMemory(root, profile, context, "insert", "profile", "b"), /1375-character limit/);
    const read = await updateContextMemory(root, profile, context, "read", "profile");
    assert.equal(read.used, 1375);
  } finally { await rm(root, { recursive: true, force: true }); }
});

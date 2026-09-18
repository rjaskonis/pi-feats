import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationStore } from "../extensions/api-server/application-store.ts";
import { ApplicationLogStore } from "../extensions/api-server/application-log-store.ts";
import { ProfileStore } from "../extensions/api-server/profile-store.ts";

test("an identity miss is logged as ignored, not as an error", () => {
  const logs = new ApplicationLogStore(join(tmpdir(), "pi-application-log-test"), "support");
  const call = logs.start({}, {});
  const result = logs.ignore(call, "unknown@example.com");

  assert.deepEqual(result, { status: "ignored", reason: "identity_miss", identityKey: "unknown@example.com" });
  assert.equal(call.status, "ignored");
  assert.equal(call.error, undefined);
  assert.equal(call.stages.at(-1)?.type, "identity-miss");
});

test("named profiles always link the shared root models catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-profile-models-"));
  try {
    const profile = join(directory, "profiles", "support");
    await mkdir(profile, { recursive: true });
    await writeFile(join(directory, "models.json"), '{"providers":{}}\n');
    await writeFile(join(profile, "models.json"), '{"providers":{"obsolete":{}}}\n');
    await writeFile(join(profile, "settings.json"), "{}\n");

    await new ProfileStore(directory).readSettings("support");

    assert.equal(await readlink(join(profile, "models.json")), join(directory, "models.json"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("deleting a profile removes all Application state that targets it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-application-store-"));
  try {
    const store = new ApplicationStore(join(directory, "applications.db"));
    store.create({ name: "Support", slug: "support", enabled: true, responseMode: "ack", defaultProfile: null, routingPolicy: "drop", settings: {} });
    store.saveIdentityMapping("support", "person@example.com", "retired", "automatic", null);
    const prefix = store.automaticPrefix("support", "person@example.com");
    store.createSession("support", "retired", prefix, "support_person_2026-09-13-01", false);
    store.createConsoleSession("console-session", "support", "retired", "person@example.com");
    assert.match(store.nextSessionId("support", "another-profile", prefix), /-02$/);

    store.deleteProfile("retired");

    assert.equal(store.identityMapping("support", "person@example.com"), undefined);
    assert.equal(store.session("support", "retired", prefix), undefined);
    assert.equal(store.consoleSession("retired", "console-session"), undefined);
    assert.equal(store.automaticPrefix("support", "person@example.com"), prefix);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

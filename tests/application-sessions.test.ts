import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationStore } from "../extensions/api-server/application-store.ts";

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

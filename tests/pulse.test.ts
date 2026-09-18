import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PulseStore } from "../extensions/pulse/store.ts";

async function withStore(run: (path: string, store: PulseStore) => void | Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-pulse-")), path = join(directory, "pulse.db");
  try { await run(path, new PulseStore(path)); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("claims a due pulse once until its execution completes", async () => {
  await withStore((path, store) => {
    const pulse = store.create({ name: "daily-report", description: "Report", schedule: "* * * * *", prompt: "Run", profile: "support", thread_session_id: "session" });
    const db = new DatabaseSync(path);
    db.prepare("UPDATE pulse_control SET next_run_at=? WHERE pulse_id=?").run("2020-01-01T00:00:00.000Z", pulse.id);

    const first = store.claimDue("2026-01-01T00:00:00.000Z");
    assert.equal(first.length, 1);
    assert.equal(store.claimDue("2026-01-01T00:00:01.000Z").length, 0);
    assert.equal(new PulseStore(path).claimDue("2026-01-01T00:00:01.000Z").length, 0);

    store.complete(first[0].pulse, first[0].runId, "done");
    assert.equal(store.runs("support", "daily-report", "2019-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z")[0].status, "success");
  });
});

test("database rejects a second active run even from a legacy writer", async () => {
  await withStore((path, store) => {
    const pulse = store.create({ name: "exclusive-report", description: "Report", schedule: "* * * * *", prompt: "Run", profile: "support", thread_session_id: "session" });
    new DatabaseSync(path).prepare("UPDATE pulse_control SET next_run_at=? WHERE pulse_id=?").run("2020-01-01T00:00:00.000Z", pulse.id);
    store.claimDue("2026-01-01T00:00:00.000Z", "tick-a");
    assert.throws(() => new DatabaseSync(path).prepare("INSERT INTO pulse_runs VALUES (?, ?, ?, NULL, 'running', NULL, NULL)").run("legacy-duplicate", pulse.id, "2026-01-01T00:00:01.000Z"), /UNIQUE constraint failed/);
  });
});

test("only the claiming tick can finish an active run", async () => {
  await withStore((path, store) => {
    const pulse = store.create({ name: "owned-report", description: "Report", schedule: "* * * * *", prompt: "Run", profile: "support", thread_session_id: "session" });
    new DatabaseSync(path).prepare("UPDATE pulse_control SET next_run_at=? WHERE pulse_id=?").run("2020-01-01T00:00:00.000Z", pulse.id);
    const [claimed] = store.claimDue("2026-01-01T00:00:00.000Z", "tick-a");
    store.complete(claimed.pulse, claimed.runId, "stale", undefined, "tick-b");
    assert.equal(store.runs("support", "owned-report", "2019-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z")[0].status, "running");
    store.complete(claimed.pulse, claimed.runId, "done", undefined, "tick-a");
    assert.equal(store.runs("support", "owned-report", "2019-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z")[0].status, "success");
  });
});

test("only one tick daemon can hold the SQLite lease", async () => {
  await withStore((_path, store) => {
    assert.equal(store.claimTickLease("tick-a"), true);
    assert.equal(new PulseStore(_path).claimTickLease("tick-b"), false);
    store.releaseTickLease("tick-a");
    assert.equal(new PulseStore(_path).claimTickLease("tick-b"), true);
  });
});

test("releases a claimed pulse after an execution failure", async () => {
  await withStore((path, store) => {
    const pulse = store.create({ name: "retry-report", description: "Report", schedule: "* * * * *", prompt: "Run", profile: "support", thread_session_id: "session" });
    new DatabaseSync(path).prepare("UPDATE pulse_control SET next_run_at=? WHERE pulse_id=?").run("2020-01-01T00:00:00.000Z", pulse.id);
    const [claimed] = store.claimDue("2026-01-01T00:00:00.000Z");
    store.fail(claimed.pulse, claimed.runId, "child failed");
    assert.equal(store.due("2030-01-01T00:00:00.000Z").length, 1);
  });
});

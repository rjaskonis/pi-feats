import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type PulseType = "cron" | "heartbeat";
export type Pulse = { id: string; name: string; description: string; type: PulseType; schedule: string; prompt: string; thread_session_id: string; result: string | null; profile: string; enabled: boolean; nextRunAt: string | null; lastRunAt: string | null };
export type PulseHistory = Pulse & { startedAt: string; finishedAt: string | null; status: string; error: string | null };
export type PulseRun = { id: string; startedAt: string; finishedAt: string | null; status: "running" | "success" | "error"; response: string | null; error: string | null };
export type ClaimedPulse = { pulse: Pulse; runId: string };
type Row = Record<string, unknown>;
const iso = (date = new Date()) => date.toISOString();

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((part) => {
    const [range, stepText] = part.split("/"); const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    const values = range === "*" ? [min, max] : range.split("-").map(Number);
    if (values.length > 2 || values.some((item) => !Number.isInteger(item)) || values[0] < min || values[values.length - 1] > max) return false;
    const [from, to] = values.length === 1 ? [values[0], values[0]] : values;
    return value >= from && value <= to && (value - from) % step === 0;
  });
}
export function validSchedule(schedule: string): boolean {
  if (/^@once:\d{4}-\d{2}-\d{2}T/.test(schedule)) return !Number.isNaN(Date.parse(schedule.slice(6)));
  const fields = schedule.trim().split(/\s+/); if (fields.length !== 5) return false;
  return [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]].every(([min, max], index) => fields[index].split(",").every((part) => {
    const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/); if (!match) return false;
    const step = match[2] ? Number(match[2]) : 1; if (!Number.isInteger(step) || step < 1) return false;
    if (match[1] === "*") return true; const values = match[1].split("-").map(Number);
    return values.every((value) => Number.isInteger(value) && value >= min && value <= max) && (values.length === 1 || values[0] <= values[1]);
  }));
}
export function nextRun(schedule: string, after = new Date()): Date | null {
  if (schedule.startsWith("@once:")) { const date = new Date(schedule.slice(6)); return date > after ? date : null; }
  if (!validSchedule(schedule)) return null;
  const [minute, hour, day, month, weekDay] = schedule.trim().split(/\s+/);
  const candidate = new Date(after); candidate.setUTCSeconds(0, 0); candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  for (let count = 0; count < 527_040; count++, candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)) {
    if (fieldMatches(minute, candidate.getUTCMinutes(), 0, 59) && fieldMatches(hour, candidate.getUTCHours(), 0, 23) && fieldMatches(day, candidate.getUTCDate(), 1, 31) && fieldMatches(month, candidate.getUTCMonth() + 1, 1, 12) && fieldMatches(weekDay, candidate.getUTCDay(), 0, 6)) return new Date(candidate);
  }
  return null;
}
export function pulseType(schedule: string): PulseType {
  if (schedule.startsWith("@once:")) return "cron";
  const [minute = "", hour = ""] = schedule.trim().split(/\s+/);
  // Classify from the declared interval, not from how a cron implementation
  // wraps an oversized step inside a single field (e.g. */1000).
  const minuteStep = minute.match(/^\*\/(\d+)$/);
  if (minuteStep) return Number(minuteStep[1]) < 240 ? "heartbeat" : "cron";
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (hourStep && minute === "0") return Number(hourStep[1]) < 4 ? "heartbeat" : "cron";
  const first = nextRun(schedule, new Date("2026-01-01T00:00:00Z")), second = first ? nextRun(schedule, first) : null;
  return first && second && second.getTime() - first.getTime() < 4 * 60 * 60 * 1000 ? "heartbeat" : "cron";
}
function heartbeatAllowed(schedule: string): boolean { return pulseType(schedule) === "heartbeat"; }

export class PulseStore {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path); this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS pulses (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('cron','heartbeat')), schedule TEXT NOT NULL, prompt TEXT NOT NULL, thread_session_id TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS pulse_control (pulse_id TEXT PRIMARY KEY REFERENCES pulses(id) ON DELETE CASCADE, profile TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT, last_run_at TEXT, claimed_at TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pulse_state (pulse_id TEXT PRIMARY KEY REFERENCES pulses(id) ON DELETE CASCADE, handoff TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pulse_runs (id TEXT PRIMARY KEY, pulse_id TEXT NOT NULL REFERENCES pulses(id) ON DELETE CASCADE, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, response TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS pulse_runs_pulse_started ON pulse_runs(pulse_id, started_at DESC);`);
    // Migrate databases created before the denormalized latest result column.
    const columns = this.db.prepare("PRAGMA table_info(pulses)").all() as Row[];
    if (!columns.some((column) => column.name === "result")) this.db.exec("ALTER TABLE pulses ADD COLUMN result TEXT");
    const controlColumns = this.db.prepare("PRAGMA table_info(pulse_control)").all() as Row[];
    if (!controlColumns.some((column) => column.name === "claimed_at")) this.db.exec("ALTER TABLE pulse_control ADD COLUMN claimed_at TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS pulse_control_due ON pulse_control(enabled, claimed_at, next_run_at)");
    this.db.exec("UPDATE pulses SET result=(SELECT response FROM pulse_runs WHERE pulse_id=pulses.id AND status='success' ORDER BY finished_at DESC LIMIT 1) WHERE result IS NULL");
    // Keep records created before the schedule-based classifier in sync.
    for (const row of this.db.prepare("SELECT id, schedule, type FROM pulses").all() as Row[]) { const type = pulseType(String(row.schedule)); if (row.type !== type) this.db.prepare("UPDATE pulses SET type=? WHERE id=?").run(type, row.id); }
  }
  private pulse(row: Row): Pulse { return { id: String(row.id), name: String(row.name), description: String(row.description), type: row.type as PulseType, schedule: String(row.schedule), prompt: String(row.prompt), thread_session_id: String(row.thread_session_id), result: row.result == null ? null : String(row.result), profile: String(row.profile), enabled: Boolean(row.enabled), nextRunAt: row.next_run_at ? String(row.next_run_at) : null, lastRunAt: row.last_run_at ? String(row.last_run_at) : null }; }
  list(profile?: string): Pulse[] { const query = `SELECT p.*, c.profile, c.enabled, c.next_run_at, c.last_run_at FROM pulses p JOIN pulse_control c ON c.pulse_id=p.id${profile ? " WHERE c.profile=?" : ""} ORDER BY p.name`; return this.db.prepare(query).all(...(profile ? [profile] : [])) .map((row) => this.pulse(row as Row)); }
  get(name: string, profile?: string): Pulse | undefined { return this.list(profile).find((item) => item.name === name); }
  history(profile: string): PulseHistory[] { return this.db.prepare(`SELECT p.*, c.profile, c.enabled, c.next_run_at, c.last_run_at, r.started_at AS startedAt, r.finished_at AS finishedAt, r.status, r.error FROM pulses p JOIN pulse_control c ON c.pulse_id=p.id JOIN pulse_runs r ON r.id=(SELECT id FROM pulse_runs WHERE pulse_id=p.id AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1) WHERE c.profile=? AND p.schedule LIKE '@once:%' ORDER BY r.started_at DESC`).all(profile).map((row) => { const record = row as Row; return { ...this.pulse(record), startedAt: String(record.startedAt), finishedAt: record.finishedAt == null ? null : String(record.finishedAt), status: String(record.status), error: record.error == null ? null : String(record.error) }; }); }
  runs(profile: string, name: string, start: string, end: string, limit = 100): PulseRun[] { const pulse = this.get(name, profile); if (!pulse) throw new Error("Pulse not found."); return this.db.prepare("SELECT id, started_at, finished_at, status, response, error FROM pulse_runs WHERE pulse_id=? AND started_at>=? AND started_at<=? ORDER BY started_at DESC LIMIT ?").all(pulse.id, start, end, limit).map((row) => { const item = row as Row; return { id: String(item.id), startedAt: String(item.started_at), finishedAt: item.finished_at == null ? null : String(item.finished_at), status: item.status as PulseRun["status"], response: item.response == null ? null : String(item.response), error: item.error == null ? null : String(item.error) }; }); }
  create(input: Omit<Pulse, "id" | "enabled" | "nextRunAt" | "lastRunAt" | "type" | "result">): Pulse {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(input.name)) throw new Error("Invalid pulse name.");
    if (!validSchedule(input.schedule)) throw new Error("Invalid schedule. Use a five-field UTC cron expression or @once:<ISO-8601>.");
    const type = pulseType(input.schedule), id = randomUUID(), next = nextRun(input.schedule)?.toISOString() ?? null;
    this.db.prepare("INSERT INTO pulses (id, name, description, type, schedule, prompt, thread_session_id, result) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(id, input.name, input.description, type, input.schedule, input.prompt, input.thread_session_id);
    this.db.prepare("INSERT INTO pulse_control (pulse_id, profile, enabled, next_run_at, last_run_at, claimed_at, updated_at) VALUES (?, ?, 1, ?, NULL, NULL, ?)").run(id, input.profile, next, iso());
    if (type === "heartbeat") this.db.prepare("INSERT INTO pulse_state VALUES (?, '', ?)").run(id, iso());
    return this.get(input.name, input.profile)!;
  }
  setEnabled(name: string, enabled: boolean, profile?: string): Pulse {
    const pulse = this.get(name, profile); if (!pulse) throw new Error("Pulse not found.");
    const next = enabled ? nextRun(pulse.schedule)?.toISOString() ?? null : null;
    this.db.prepare("UPDATE pulse_control SET enabled=?, next_run_at=?, updated_at=? WHERE pulse_id=?").run(enabled ? 1 : 0, next, iso(), pulse.id);
    return this.get(name, profile)!;
  }
  update(name: string, profile: string | undefined, input: Pick<Pulse, "description" | "schedule" | "prompt" | "thread_session_id">): Pulse {
    const pulse = this.get(name, profile); if (!pulse) throw new Error("Pulse not found.");
    if (!validSchedule(input.schedule)) throw new Error("Invalid schedule. Use a five-field UTC cron expression or @once:<ISO-8601>.");
    const type = pulseType(input.schedule);
    this.db.prepare("UPDATE pulses SET description=?, type=?, schedule=?, prompt=?, thread_session_id=? WHERE id=?").run(input.description, type, input.schedule, input.prompt, input.thread_session_id, pulse.id);
    this.db.prepare("UPDATE pulse_control SET next_run_at=?, updated_at=? WHERE pulse_id=?").run(pulse.enabled ? nextRun(input.schedule)?.toISOString() ?? null : null, iso(), pulse.id);
    return this.get(name, profile)!;
  }
  delete(name: string, profile?: string): void { const pulse = this.get(name, profile); if (!pulse) throw new Error("Pulse not found."); this.db.prepare("DELETE FROM pulses WHERE id=?").run(pulse.id); }
  deleteProfile(profile: string): void { this.db.prepare("DELETE FROM pulses WHERE id IN (SELECT pulse_id FROM pulse_control WHERE profile=?)").run(profile); }
  due(now = iso()): Pulse[] { return this.db.prepare("SELECT p.*, c.profile, c.enabled, c.next_run_at, c.last_run_at FROM pulses p JOIN pulse_control c ON c.pulse_id=p.id WHERE c.enabled=1 AND c.claimed_at IS NULL AND c.next_run_at IS NOT NULL AND c.next_run_at<=? ORDER BY c.next_run_at").all(now).map((row) => this.pulse(row as Row)); }
  claimDue(now = iso()): ClaimedPulse[] {
    const claimed: ClaimedPulse[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const pulse of this.due(now)) {
        const result = this.db.prepare("UPDATE pulse_control SET claimed_at=?, next_run_at=NULL, updated_at=? WHERE pulse_id=? AND enabled=1 AND claimed_at IS NULL AND next_run_at IS NOT NULL AND next_run_at<=?").run(now, now, pulse.id, now);
        if (!result.changes) continue;
        const runId = randomUUID();
        this.db.prepare("INSERT INTO pulse_runs VALUES (?, ?, ?, NULL, 'running', NULL, NULL)").run(runId, pulse.id, now);
        claimed.push({ pulse, runId });
      }
      this.db.exec("COMMIT");
      return claimed;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  complete(pulse: Pulse, runId: string, response: string, handoff?: string): void { const next = nextRun(pulse.schedule)?.toISOString() ?? null; this.db.prepare("UPDATE pulse_runs SET finished_at=?, status='success', response=? WHERE id=?").run(iso(), response, runId); this.db.prepare("UPDATE pulses SET result=? WHERE id=?").run(response, pulse.id); this.db.prepare("UPDATE pulse_control SET last_run_at=?, next_run_at=?, claimed_at=NULL, updated_at=? WHERE pulse_id=?").run(iso(), next, iso(), pulse.id); if (pulse.type === "heartbeat" && handoff !== undefined) this.db.prepare("UPDATE pulse_state SET handoff=?, updated_at=? WHERE pulse_id=?").run(handoff, iso(), pulse.id); }
  fail(pulse: Pulse, runId: string, error: string): void { this.db.prepare("UPDATE pulse_runs SET finished_at=?, status='error', error=? WHERE id=?").run(iso(), error, runId); this.db.prepare("UPDATE pulse_control SET next_run_at=?, claimed_at=NULL, updated_at=? WHERE pulse_id=?").run(nextRun(pulse.schedule, new Date(Date.now() + 60_000))?.toISOString() ?? null, iso(), pulse.id); }
  handoff(id: string): string { return String((this.db.prepare("SELECT handoff FROM pulse_state WHERE pulse_id=?").get(id) as Row | undefined)?.handoff ?? ""); }
  retarget(profile: string, from: string, to: string): void { this.db.prepare("UPDATE pulses SET thread_session_id=? WHERE id IN (SELECT pulse_id FROM pulse_control WHERE profile=?) AND thread_session_id=?").run(to, profile, from); }
}

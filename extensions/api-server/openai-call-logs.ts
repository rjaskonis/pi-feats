import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CallStage, OpenAICallDetail, OpenAICallLog, OpenAICallLogPage } from "../lib/openai-call-log-types.ts";

const retention = 5_000;
export const openAICallDetailRetention = 500;
const pageSize = 100;
export type OpenAICallQuery = { endpoint?: string; profile?: string; outcome?: string; before?: string; start?: string; end?: string };
type StoredCall = Omit<OpenAICallLog, "stream"> & { seq: number; stream: number | null };
function toCall({ seq: _seq, stream, ...call }: StoredCall): OpenAICallLog { return { ...call, stream: stream === null ? null : Boolean(stream) }; }

export class OpenAICallLogs {
  private readonly db: DatabaseSync;
  private readonly active = new Map<string, OpenAICallDetail>();
  private readonly listeners = new Set<(id: string) => void>();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS calls (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL, receivedAt TEXT NOT NULL, endpoint TEXT NOT NULL,
      profile TEXT, stream INTEGER, httpStatus INTEGER, outcome TEXT NOT NULL, durationMs INTEGER NOT NULL, errorCode TEXT
    );
    CREATE INDEX IF NOT EXISTS openai_calls_id ON calls(id);
    CREATE TABLE IF NOT EXISTS call_details (seq INTEGER PRIMARY KEY, stages TEXT NOT NULL);`);
  }

  subscribe(listener: (id: string) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(id: string) {
    for (const listener of this.listeners) {
      try { listener(id); } catch { this.listeners.delete(listener); }
    }
  }

  update(detail: OpenAICallDetail) {
    const id = detail.call.id;
    if (!this.active.has(id) && this.active.size >= pageSize) this.active.delete(this.active.keys().next().value!);
    this.active.set(id, detail);
    this.emit(id);
  }

  record(call: OpenAICallLog, stages?: CallStage[]): void {
    const { id, receivedAt, endpoint, profile, stream, httpStatus, outcome, durationMs, errorCode } = call;
    this.active.delete(id);
    this.db.exec("BEGIN");
    try {
      const inserted = this.db.prepare("INSERT INTO calls (id, receivedAt, endpoint, profile, stream, httpStatus, outcome, durationMs, errorCode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, receivedAt, endpoint, profile, stream === null ? null : Number(stream), httpStatus, outcome, durationMs, errorCode);
      const seq = Number(inserted.lastInsertRowid);
      if (stages) this.db.prepare("INSERT INTO call_details (seq, stages) VALUES (?, ?)").run(seq, JSON.stringify(stages));
      this.db.prepare("DELETE FROM call_details WHERE seq <= ?").run(seq - openAICallDetailRetention);
      this.db.prepare("DELETE FROM calls WHERE seq <= ?").run(seq - retention);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally { this.emit(id); }
  }

  detail(id: string): OpenAICallDetail | undefined {
    const running = this.active.get(id);
    if (running) return running;
    const row = this.db.prepare("SELECT calls.*, call_details.stages FROM calls LEFT JOIN call_details USING (seq) WHERE id = ?").get(id) as unknown as (StoredCall & { stages: string | null }) | undefined;
    if (!row) return;
    const { stages, ...call } = row;
    return { call: toCall(call), stages: stages ? JSON.parse(stages) as CallStage[] : null };
  }

  list(query: OpenAICallQuery): OpenAICallLogPage {
    const before = Number(query.before);
    const cursor = Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;
    const endpoints = query.endpoint?.split(",").filter(Boolean), outcomes = query.outcome?.split(",").filter(Boolean);
    const endpointFilter = endpoints?.length ? JSON.stringify(endpoints) : null;
    const outcomeFilter = outcomes?.length ? JSON.stringify(outcomes) : null;
    const active = query.before ? [] : [...this.active.values()].map(({ call }) => call).filter((call) =>
      (!endpoints?.length || endpoints.includes(call.endpoint)) && (!query.profile || call.profile === query.profile) &&
      (!outcomes?.length || outcomes.includes(call.outcome)) && (!query.start || call.receivedAt >= query.start) && (!query.end || call.receivedAt <= query.end))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    const rows = this.db.prepare(`SELECT * FROM calls WHERE seq < ?
      AND (? IS NULL OR endpoint IN (SELECT value FROM json_each(?))) AND (? IS NULL OR profile = ?)
      AND (? IS NULL OR outcome IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR receivedAt >= ?) AND (? IS NULL OR receivedAt <= ?)
      ORDER BY seq DESC LIMIT ?`).all(cursor, endpointFilter, endpointFilter,
      query.profile ?? null, query.profile ?? null, outcomeFilter, outcomeFilter,
      query.start ?? null, query.start ?? null, query.end ?? null, query.end ?? null, pageSize + 1) as unknown as StoredCall[];
    return { calls: [...active, ...rows.slice(0, pageSize).map(toCall)], next: rows.length > pageSize ? String(rows[pageSize - 1].seq) : null };
  }

  close(): void { this.db.close(); }
}

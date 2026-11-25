import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { OpenAICallLog, OpenAICallLogPage } from "../lib/openai-call-log-types.ts";

const retention = 5_000;
const pageSize = 100;

export class OpenAICallLogs {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS calls (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL, receivedAt TEXT NOT NULL, endpoint TEXT NOT NULL,
      profile TEXT, stream INTEGER, httpStatus INTEGER, outcome TEXT NOT NULL, durationMs INTEGER NOT NULL, errorCode TEXT
    )`);
  }

  record(call: OpenAICallLog): void {
    const { id, receivedAt, endpoint, profile, stream, httpStatus, outcome, durationMs, errorCode } = call;
    this.db.exec("BEGIN");
    try {
      const inserted = this.db.prepare("INSERT INTO calls (id, receivedAt, endpoint, profile, stream, httpStatus, outcome, durationMs, errorCode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, receivedAt, endpoint, profile, stream === null ? null : Number(stream), httpStatus, outcome, durationMs, errorCode);
      this.db.prepare("DELETE FROM calls WHERE seq <= ?").run(Number(inserted.lastInsertRowid) - retention);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(query: { endpoint?: string; profile?: string; outcome?: string; before?: string }): OpenAICallLogPage {
    const before = Number(query.before);
    const cursor = Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;
    const rows = this.db.prepare(`SELECT * FROM calls WHERE seq < ?
      AND (? IS NULL OR endpoint = ?) AND (? IS NULL OR profile = ?) AND (? IS NULL OR outcome = ?)
      ORDER BY seq DESC LIMIT ?`).all(cursor, query.endpoint ?? null, query.endpoint ?? null,
      query.profile ?? null, query.profile ?? null, query.outcome ?? null, query.outcome ?? null, pageSize + 1) as unknown as
        Array<Omit<OpenAICallLog, "stream"> & { seq: number; stream: number | null }>;
    return {
      calls: rows.slice(0, pageSize).map(({ seq: _seq, stream, ...call }) => ({ ...call, stream: stream === null ? null : Boolean(stream) })),
      next: rows.length > pageSize ? String(rows[pageSize - 1].seq) : null,
    };
  }

  close(): void { this.db.close(); }
}

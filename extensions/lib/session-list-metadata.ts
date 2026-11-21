import { createReadStream, type Dirent, type BigIntStats } from "node:fs";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

export type ListedSession = {
  path: string; id: string; cwd: string; name?: string; firstMessage: string; modified: Date; pulseOnly: boolean;
};
type Metadata = Omit<ListedSession, "path" | "modified"> & { modified: number };
type Cached = { stamp: string; data: Metadata };
const cacheVersion = 1;
const stamp = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const fileStats = (path: string) => stat(path, { bigint: true }).catch(() => undefined);

async function scan(path: string, stats: BigIntStats): Promise<Metadata | undefined> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let header: { id: string; cwd?: string; timestamp?: string; version?: number } | undefined;
  let name: string | undefined, firstMessage = "", activity = 0;
  // Keep only the shape of the active branch, never message bodies or tool output.
  const entries = new Map<string, { parent?: string; kind: number }>();
  let leaf: string | undefined, legacyRelevant = false, legacyOther = false;
  try {
    for await (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== "object") continue;
      if (!header) {
        if (entry.type !== "session" || typeof entry.id !== "string") return;
        header = entry;
        continue;
      }
      if (entry.type === "session") continue;
      const message = entry.message;
      const pulse = entry.type === "pulse" || (entry.type === "custom_message" && entry.customType === "pulse");
      const relevant = pulse || ["custom_message", "compaction", "branch_summary"].includes(entry.type) || (entry.type === "message" && message?.role !== "system");
      if ((header!.version ?? 1) < 2) { legacyRelevant ||= relevant; legacyOther ||= relevant && !pulse; }
      else if (typeof entry.id === "string") { leaf = entry.id; entries.set(leaf!, { parent: entry.parentId, kind: pulse ? 1 : relevant ? 2 : 0 }); }
      if (entry.type === "session_info") name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
      if (entry.type !== "message" || !message || typeof message !== "object" || !["user", "assistant"].includes(message.role) || !("content" in message)) continue;
      const when = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
      if (Number.isFinite(when)) activity = Math.max(activity, when);
      if (!firstMessage && message.role === "user") firstMessage = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join(" ") : "";
    }
  } finally { lines.close(); stream.destroy(); }
  if (!header) return;
  let pulseOnly = legacyRelevant && !legacyOther;
  while (leaf) {
    const entry = entries.get(leaf);
    if (!entry) break;
    entries.delete(leaf); // Also bounds traversal for damaged cyclic histories.
    if (entry.kind === 2) { pulseOnly = false; break; }
    if (entry.kind === 1) pulseOnly = true;
    leaf = entry.parent;
  }
  const created = Date.parse(header.timestamp ?? "");
  return { id: header.id, cwd: typeof header.cwd === "string" ? header.cwd : "", name, firstMessage: firstMessage.slice(0, 4096) || "(no messages)", modified: activity || (Number.isFinite(created) ? created : Number(stats.mtimeMs)), pulseOnly };
}

function valid(data: Metadata | undefined): data is Metadata {
  return !!data && typeof data.id === "string" && typeof data.cwd === "string" && typeof data.firstMessage === "string" && (data.name === undefined || typeof data.name === "string") && Number.isFinite(data.modified) && typeof data.pulseOnly === "boolean";
}

/** List the same layouts as Pi: flat explicit session dir or grouped default dirs. */
export async function listSessionMetadata(agentDir: string, sessionDir?: string): Promise<ListedSession[]> {
  const cachePath = join(agentDir, ".session-list-index.json");
  const root = sessionDir ?? join(agentDir, "sessions");
  const names = async (dir: string) => (await readdir(dir).catch(() => [])).filter(name => name.endsWith(".jsonl")).map(name => join(dir, name));
  const dirs = sessionDir ? [root] : (await readdir(root, { withFileTypes: true }).catch((): Dirent[] => [])).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => join(root, entry.name));
  const files = (await Promise.all(dirs.map(names))).flat();
  let previous: Record<string, Cached> = {};
  try {
    const saved = JSON.parse(await readFile(cachePath, "utf8"));
    if (saved.version === cacheVersion && saved.root === root && saved.files && typeof saved.files === "object") previous = saved.files;
  } catch { /* The index is disposable. */ }
  const candidates = await Promise.all(files.map(async path => ({ path, stats: await fileStats(path) })));
  candidates.sort((a, b) => {
    if (!sessionDir && a.stats?.mtimeNs !== b.stats?.mtimeNs) return (b.stats?.mtimeNs ?? -1n) > (a.stats?.mtimeNs ?? -1n) ? 1 : -1;
    return basename(b.path).localeCompare(basename(a.path));
  });
  const next: Record<string, Cached> = Object.create(null);
  const output: Array<ListedSession | undefined> = new Array(candidates.length);
  let cursor = 0, changed = candidates.length !== Object.keys(previous).length;
  await Promise.all(Array.from({ length: Math.min(10, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const i = cursor++, { path, stats } = candidates[i];
      if (!stats?.isFile()) continue;
      const key = stamp(stats), cached = previous[path];
      let data: Metadata | undefined;
      if (cached?.stamp === key && valid(cached.data)) { data = cached.data; next[path] = { stamp: key, data }; }
      else {
        changed = true;
        data = await scan(path, stats).catch(() => undefined);
        const after = await fileStats(path);
        if (data && after && stamp(after) === key) next[path] = { stamp: key, data };
      }
      if (data) output[i] = { ...data, name: data.name, path, modified: new Date(data.modified) };
    }
  }));
  if (changed || Object.keys(next).length !== Object.keys(previous).length) {
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: cacheVersion, root, files: next }), { mode: 0o600, flag: "wx" });
      await rename(temporary, cachePath);
    } catch { /* An unwritable index must not break listing. */ }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  return output.filter((item): item is ListedSession => !!item).sort((a, b) => +b.modified - +a.modified);
}

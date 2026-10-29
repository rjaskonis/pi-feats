import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

/** A legacy filename alias is evidence only when backed by a stored reference. */
export function sessionFileHasAlias(file: string, id: string): boolean {
  return basename(file).endsWith(`_${id}.jsonl`);
}

/** Resolve authoritative header IDs as well as filenames from older runtimes. */
export async function findSessionFile(directory: string, id: string): Promise<{ file: string; cwd: string } | undefined> {
  const candidates: Array<{ file: string; cwd: string }> = [];
  async function visit(path: string): Promise<{ file: string; cwd: string } | undefined> {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) {
        const match = await visit(file);
        if (match) return match;
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stream = createReadStream(file, { encoding: "utf8" });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            const header = JSON.parse(line);
            if (header.type !== "session") break;
            const result = { file, cwd: typeof header.cwd === "string" ? header.cwd : process.cwd() };
            if (header.id === id) return result;
            if (sessionFileHasAlias(file, id)) candidates.push(result);
            break;
          }
        } catch {
          // A damaged or concurrently removed file must not hide other sessions.
        } finally {
          lines.close();
          stream.destroy();
        }
      }
    }
  }
  return await visit(directory) ?? (candidates.length === 1 ? candidates[0] : undefined);
}

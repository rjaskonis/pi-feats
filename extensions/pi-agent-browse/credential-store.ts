import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, lstat, open, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { Credential, CredentialStore } from "./broker.ts";

// Browser credentials live in each profile workspace. A control-plane signature prevents a
// sandboxed profile from editing its own file to impersonate another profile/browser.
export async function profileBrowserCredentials(root: string, profiles: () => Promise<{ name: string }[]>, directory: (profile: string) => string): Promise<CredentialStore> {
  const keyFile = join(root, "browser", "signing.key");
  await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
  try { await writeFile(keyFile, randomBytes(32), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const key = await readFile(keyFile);
  if (key.length !== 32) throw new Error("Invalid browser credential signing key");
  const signature = (profile: string, credentials: Credential[]) => createHmac("sha256", key).update(JSON.stringify({ profile, credentials })).digest("hex");
  const withDirectory = async <T>(profile: string, create: boolean, operation: (file: string) => Promise<T>) => {
    const folder = join(directory(profile), "browser");
    if (create) await mkdir(folder, { recursive: true, mode: 0o700 });
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Browser credential directory must not be a symlink");
    const handle = await open(folder, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      // Pin the directory inode on Linux, where Nono sandboxes can modify their own workspace.
      const pinned = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : folder;
      return await operation(join(pinned, "credentials.json"));
    } finally { await handle.close(); }
  };
  let known = new Set<string>();
  const previous = new Map<string, string>();
  return {
    async load() {
      known.clear(); previous.clear();
      const records: Credential[] = [];
      for (const { name } of await profiles()) {
        try {
          const value = await withDirectory(name, false, async file => {
            const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            try {
              const info = await handle.stat();
              if (!info.isFile() || info.size > 128 * 1024) throw new Error("Invalid browser credential file");
              return JSON.parse(await handle.readFile("utf8"));
            } finally { await handle.close(); }
          });
          if (!Array.isArray(value.credentials) || value.credentials.some((item: Credential) => item.profile !== name) || !/^[a-f0-9]{64}$/.test(value.signature ?? "") || !timingSafeEqual(Buffer.from(value.signature), Buffer.from(signature(name, value.credentials)))) throw new Error("Invalid credential signature");
          records.push(...value.credentials); known.add(name);
          previous.set(name, JSON.stringify(value.credentials));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Ignoring invalid browser credentials for profile ${name}. Pair again in Console.`);
        }
      }
      return records;
    },
    async save(credentials) {
      const names = new Set([...known, ...credentials.map(item => item.profile)]);
      const existing = new Set((await profiles()).map(item => item.name));
      for (const name of names) {
        if (!existing.has(name)) continue;
        const records = credentials.filter(item => item.profile === name);
        const serialized = JSON.stringify(records);
        if (previous.get(name) === serialized) continue;
        await withDirectory(name, true, async file => {
          const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
          await writeFile(temporary, JSON.stringify({ credentials: records, signature: signature(name, records) }), { flag: "wx", mode: 0o600 });
          await rename(temporary, file);
        });
        previous.set(name, serialized);
      }
      known = names;
    },
  };
}

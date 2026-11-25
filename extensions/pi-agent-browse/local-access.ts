import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const localBrowserPort = 20087;
export const localBrowserDirectory = (root: string) => join(root, "browser-local", "shared");
export const browserProfileName = (name: string) => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name);

export async function localBrowserKey(root: string, create = false): Promise<Buffer> {
  const directory = localBrowserDirectory(root);
  const path = join(directory, "shared.key");
  if (create) {
    const existing = await localBrowserKey(root).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) return existing;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomBytes(8).toString("hex")}`;
    await writeFile(temporary, randomBytes(32), { flag: "wx", mode: 0o600 });
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { await unlink(temporary); }
  }
  const key = await readFile(path);
  if (key.length !== 32) throw new Error("Invalid shared browser relay key");
  return key;
}

export async function localProfileIdentity(root: string, profile: string): Promise<string> {
  if (!browserProfileName(profile)) throw new Error("Invalid profile name");
  if (profile === "default") return "default";
  const path = join(root, "profiles", profile);
  const [directory, settings] = await Promise.all([lstat(path, { bigint: true }), lstat(join(path, "settings.json"))]);
  if (!directory.isDirectory() || !settings.isFile()) throw new Error("Invalid profile workspace");
  return `${directory.dev}:${directory.ino}:${directory.birthtimeNs || directory.ctimeNs}`;
}

export function localBrowserSecret(key: Buffer, purpose: string, profile = "", identity = "") {
  return createHmac("sha256", key).update(JSON.stringify([purpose, profile, identity])).digest("base64url");
}

export function localBrowserSecretMatches(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function localBrowserCapability(root: string, profile: string, create = false) {
  const [key, identity] = await Promise.all([localBrowserKey(root, create), localProfileIdentity(root, profile)]);
  return `${profile}.${localBrowserSecret(key, "worker", profile, identity)}`;
}

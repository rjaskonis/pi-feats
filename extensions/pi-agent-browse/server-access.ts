import { createServer, createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { browserProfileName, localBrowserSecretMatches } from "./local-access.ts";

export const serverBrowserMarker = "PI_BROWSER_SERVER_MODE";
const descriptor = (root: string) => join(root, "browser", "launcher.json");

// The launcher descriptor and private socket directory are never granted to Nono profiles.
export async function startServerBrowserAccess(root: string, port: number, tokenFor: (profile: string) => Promise<string>) {
  const path = descriptor(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(dirname(path), "pty-"));
  const socketPath = join(directory, "broker.sock");
  const launcherSecret = randomBytes(32).toString("base64url");
  const server = createServer(socket => {
    socket.on("error", () => socket.destroy());
    socket.setTimeout(1000, () => socket.destroy());
    let input = "";
    socket.on("data", data => {
      input += data.toString("utf8");
      if (input.length > 109) return socket.destroy();
      if (!input.endsWith("\n")) return;
      socket.pause();
      const [secret, profile, extra] = input.slice(0, -1).split(" ");
      if (extra !== undefined || !localBrowserSecretMatches(secret, launcherSecret) || !browserProfileName(profile ?? "")) return socket.end("{}\n");
      void tokenFor(profile).then(token => socket.end(JSON.stringify({ token, port }) + "\n"), () => socket.end("{}\n"));
    });
  });
  server.maxConnections = 32;
  const close = async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.off("error", reject); resolve(); });
    });
    await chmod(socketPath, 0o600);
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify({ socketPath, launcherSecret }), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) { await close(); throw error; }
  // Retain the descriptor on stop so server sessions fail closed rather than using the local relay.
  return close;
}

export function expectsServerBrowser(environment: NodeJS.ProcessEnv) {
  return environment[serverBrowserMarker] === "1" || !!environment.PI_API_PROXY_TARGET;
}

export async function serverBrowserEnvironment(root: string, profile: string, environment: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (environment.PI_BROWSER_ENDPOINT || environment.PI_BROWSER_TOKEN) return {};
  const unavailable = { [serverBrowserMarker]: "1" };
  // A sandboxed child must not acquire a different profile binding.
  if (environment.PI_PROFILE_REEXEC === "1") return expectsServerBrowser(environment) ? unavailable : {};
  try {
    const path = descriptor(root);
    if (!(await lstat(path)).isFile()) return unavailable;
    const { socketPath, launcherSecret } = JSON.parse(await readFile(path, "utf8"));
    if (typeof socketPath !== "string" || typeof launcherSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(launcherSecret)) return unavailable;
    const result = await new Promise<{ token?: string; port?: number }>((resolve, reject) => {
      const socket = createConnection(socketPath), chunks: Buffer[] = [];
      let length = 0;
      const fail = (error: Error) => { socket.destroy(); reject(error); };
      socket.setTimeout(1000, () => fail(new Error("Browser launcher timed out")));
      socket.on("error", fail);
      socket.on("connect", () => socket.write(`${launcherSecret} ${profile}\n`));
      socket.on("data", data => { length += data.length; if (length > 1024) fail(new Error("Invalid browser launcher response")); else chunks.push(data); });
      socket.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); } });
    });
    if (!/^[A-Za-z0-9_-]{43}$/.test(result.token ?? "") || !Number.isInteger(result.port) || result.port! < 1 || result.port! > 65535) return unavailable;
    return { ...unavailable, PI_BROWSER_ENDPOINT: `http://127.0.0.1:${result.port}`, PI_BROWSER_TOKEN: result.token };
  } catch (error) {
    // An absent socket after reading a descriptor also means the server is unavailable.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !expectsServerBrowser(environment)) {
      const present = await lstat(descriptor(root)).then(() => true, () => false);
      if (!present) return {};
    }
    return unavailable;
  }
}

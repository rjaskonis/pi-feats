import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { browserConnection, browserRequest } from "./client.ts";
import { browserRuntimeVersion } from "./version.ts";

export async function handleBrowserCli(args: string[], profile: string, root: string) {
  const action = args[1] ?? "status";
  if (!["install", "pair", "status", "unpair", "stop"].includes(action) || args.length > 2) throw new Error("Usage: pi browser install | pair | status | unpair | stop");
  const agentDir = profile === "default" ? root : join(root, "profiles", profile);
  if (profile !== "default") await readFile(join(agentDir, "settings.json"), "utf8");
  const directory = join(agentDir, "browser-local");
  const path = join(directory, "connection.json");
  const statusPath = `/api/browser/profiles/${encodeURIComponent(profile)}/status`;
  const connect = () => browserConnection(agentDir, {});
  const running = async () => {
    try { const connection = await connect(); await browserRequest(connection, statusPath); return connection; } catch { return undefined; }
  };
  let connection = await running();
  if (connection && (action === "install" || action === "pair")) {
    const state = JSON.parse(await readFile(path, "utf8"));
    if (state.runtimeVersion !== browserRuntimeVersion()) {
      await browserRequest(connection, "/api/browser/local/stop", {});
      for (let attempt = 0; attempt < 60 && connection; attempt++) { await new Promise(resolve => setTimeout(resolve, 100)); connection = await running(); }
      if (connection) throw new Error("Previous browser relay did not stop; retry after it exits.");
    }
  }
  if (!connection && (action === "install" || action === "pair")) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = join(directory, "starting.lock");
    try { await (await open(lock, "wx", 0o600)).close(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const state = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
      let alive = false;
      if (Number.isSafeInteger(state.pid) && state.pid > 0) { try { process.kill(state.pid, 0); alive = true; } catch {} }
      if (alive) throw new Error("Browser relay is already starting or unavailable. Run pi browser stop, then pair again.");
      // A stale lock is only removed after its owning process has exited.
      if (Date.now() - (await stat(lock)).mtimeMs < 30_000) throw new Error("Browser relay is starting; retry in a few seconds.");
      await unlink(lock);
      return handleBrowserCli(args, profile, root);
    }
    try {
      let state: { token: string; port: number; profile: string };
      try { state = JSON.parse(await readFile(path, "utf8")); }
      catch { state = { token: randomBytes(32).toString("base64url"), port: profile === "default" ? 20087 : 21000 + createHash("sha256").update(profile).digest().readUInt16BE(0) % 20000, profile }; }
      await writeFile(path, JSON.stringify({ ...state, profile }), { mode: 0o600 });
      const log = await open(join(directory, "relay.log"), "a", 0o600);
      const child = spawn(process.execPath, [fileURLToPath(new URL("./local-daemon.mjs", import.meta.url)), directory], { detached: true, stdio: ["ignore", log.fd, log.fd], env: { ...process.env, PI_BROWSER_ENDPOINT: "", PI_BROWSER_TOKEN: "" } });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      await writeFile(path, JSON.stringify({ ...state, profile, pid: child.pid }), { mode: 0o600 });
      child.unref(); await log.close();
      for (let i = 0; i < 60 && !connection; i++) { await new Promise(resolve => setTimeout(resolve, 100)); connection = await running(); }
      if (!connection) throw new Error(`Browser relay could not start. Check ${join(directory, "relay.log")}. A previous native relay may already own this port.`);
    } catch (error) { await unlink(lock).catch(() => {}); throw error; }
  }
  if (!connection) { console.log("Browser relay is not running. Run pi browser pair to install/start it."); return; }
  const state = JSON.parse(await readFile(path, "utf8"));
  if (action === "install") { console.log(`Browser relay ready at 127.0.0.1:${state.port}. Runtime is supplied by pi-feats; no native download or administrator access is needed. Run pi browser pair.`); return; }
  if (action === "pair") {
    const result = await browserRequest(connection, `/api/browser/profiles/${encodeURIComponent(profile)}/pair`, {});
    console.log(`Pairing code: ${result.code}\nExpires: ${new Date(result.expiresAt).toISOString()}\nProfile: ${profile}\nOpen Pi Agent Browse Settings, choose Local relay, enter 127.0.0.1:${state.port}, paste the code and Connect.`);
  } else if (action === "unpair") {
    await browserRequest(connection, `/api/browser/profiles/${encodeURIComponent(profile)}/unpair`, {});
    console.log("Browser pairing revoked.");
  } else if (action === "stop") {
    await browserRequest(connection, "/api/browser/local/stop", {});
    console.log("Browser relay is stopping.");
  } else console.log(JSON.stringify(await browserRequest(connection, statusPath), null, 2));
}

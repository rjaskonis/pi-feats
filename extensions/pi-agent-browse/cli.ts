import { open, readdir, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { browserRequest, executeBrowserAction } from "./client.ts";
import { browserProfileName, localBrowserCapability, localBrowserDirectory, localBrowserKey, localBrowserPort, localBrowserSecret } from "./local-access.ts";
import { browserRuntimeVersion } from "./version.ts";
import { expectsServerBrowser, serverBrowserEnvironment } from "./server-access.ts";

const wait = () => new Promise(resolve => setTimeout(resolve, 100));
const localStatus = "/api/browser/local/status";
const stop = "/api/browser/local/stop";

async function retireLegacyRelays(root: string, defaultPort: number) {
  const names = ["default", ...(await readdir(join(root, "profiles"), { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  })).filter(item => item.isDirectory() && item.name !== "default" && browserProfileName(item.name)).map(item => item.name)];
  let retired = false;
  for (const profile of names) {
    const folder = profile === "default" ? root : join(root, "profiles", profile);
    const port = profile === "default" ? defaultPort : 21000 + createHash("sha256").update(profile).digest().readUInt16BE(0) % 20000;
    const file = await open(join(folder, "browser-local", "connection.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch(() => undefined);
    if (!file) continue;
    const state = await (async () => {
      try {
        const info = await file.stat();
        if (info.isFile() && info.size <= 4096) return JSON.parse(await file.readFile("utf8"));
      } catch { return undefined; }
      finally { await file.close(); }
    })();
    if (state?.profile !== profile || state.port !== port || typeof state.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state.token)) continue;
    const connection = { endpoint: `http://127.0.0.1:${port}`, token: state.token };
    const path = `/api/browser/profiles/${encodeURIComponent(profile)}/status`;
    const running = () => browserRequest(connection, path, undefined, AbortSignal.timeout(1000)).then(result => result?.available === true && Array.isArray(result.browsers)).catch(() => false);
    if (!await running()) continue;
    await browserRequest(connection, stop, {}, AbortSignal.timeout(1500));
    for (let i = 0; i < 60; i++) {
      await wait();
      if (!await running()) break;
      if (i === 59) throw new Error(`Previous browser relay for ${profile} did not stop.`);
    }
    retired = true;
  }
  if (retired) console.log("Previous profile relays stopped. Pair Chrome once with the shared relay.");
}

export async function handleBrowserCli(args: string[], profile: string, root: string, profileSession = false, port = localBrowserPort) {
  const action = args[1] ?? "status";
  if (!["install", "pair", "status", "unpair", "stop"].includes(action) || args.length > 2) {
    throw new Error("Usage: pi browser install | pair | status | unpair | stop");
  }
  if (profileSession && profile !== process.env.PI_ACTIVE_PROFILE) throw new Error("Cannot inspect another browser profile from this session.");
  const environment = { ...process.env, ...await serverBrowserEnvironment(root, profile, process.env) };
  const remote = !!(environment.PI_BROWSER_ENDPOINT || environment.PI_BROWSER_TOKEN || expectsServerBrowser(environment));
  if (remote && action === "pair" && profile === "default" && !profileSession && environment.PI_BROWSER_ENDPOINT && environment.PI_BROWSER_TOKEN) {
    const result = await executeBrowserAction(root, { action: "pair", loopbackOnly: true }, undefined, environment);
    console.log(`Pairing code: ${result.code}\nExpires: ${new Date(result.expiresAt).toISOString()}\nExtension ZIP: ${result.downloadUrl}\nOpen Pi Agent Browse Settings, choose Local Console (${result.address}), paste the code and click Connect.`);
    return;
  }
  if (remote && action !== "status") throw new Error("Use the Console to manage server browser pairing. This server does not use the standalone local relay.");
  if (profile !== "default" || profileSession || remote) {
    if (action !== "status") throw new Error("The browser relay is shared. Run pi browser pair once from a terminal outside the named profile.");
    const directory = profile === "default" ? root : join(root, "profiles", profile);
    const result = !profileSession && !remote
      ? await localBrowserCapability(root, profile).then(token => executeBrowserAction(directory, { action: "status" }, undefined, { PI_BROWSER_LOCAL_CAPABILITY: token })).catch(error => {
        if (error.code === "ENOENT") return { connectionState: "relay_not_running" };
        throw error;
      })
      : await executeBrowserAction(directory, { action: "status" }, undefined, environment);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const start = action === "install" || action === "pair";
  const key = await localBrowserKey(root, start).catch(error => {
    if (error.code === "ENOENT" && !start) return undefined;
    throw error;
  });
  const connection = key && { endpoint: `http://127.0.0.1:${port}`, token: localBrowserSecret(key, "admin") };
  if (!connection) {
    console.log("Shared browser relay is not running. Run pi browser install to start it."); return;
  }
  const running = () => browserRequest(connection, localStatus, undefined, AbortSignal.timeout(1000)).catch(() => undefined);
  let status = await running();
  if (start && status?.runtimeVersion !== browserRuntimeVersion()) {
    const directory = localBrowserDirectory(root);
    const lock = join(directory, "starting.lock");
    const handle = await open(lock, "wx", 0o600).catch(error => {
      if (error.code === "EEXIST") throw new Error(`Shared browser relay setup is already running. If interrupted, remove the stale lock at ${lock} and retry.`);
      throw error;
    });
    try {
      status = await running();
      if (status && status.runtimeVersion !== browserRuntimeVersion()) {
        await browserRequest(connection, stop, {});
        for (let i = 0; i < 60 && status; i++) { await wait(); status = await running(); }
        if (status) throw new Error("Previous shared relay did not stop.");
      }
      if (!status) {
        await retireLegacyRelays(root, port);
        const logPath = join(directory, "relay.log");
        const log = await open(logPath, "a", 0o600);
        const child = spawn(process.execPath, [fileURLToPath(new URL("./local-daemon.mjs", import.meta.url)), root, String(port)], { detached: true, stdio: ["ignore", log.fd, log.fd] });
        try { await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); }
        finally { await log.close(); }
        child.unref();
        for (let i = 0; i < 60 && !status && child.exitCode === null; i++) { await wait(); status = await running(); }
        if (!status) throw new Error(`Shared relay could not start on 127.0.0.1:${port}. Check for a port conflict and review ${logPath}.`);
      }
    } finally { await handle.close(); await unlink(lock); }
  }
  if (!status) {
    console.log("Shared browser relay is not running. Run pi browser install to start it."); return;
  }
  if (action === "install") console.log(`Shared browser relay ready at 127.0.0.1:${port}. Run pi browser pair if Chrome has not been paired.`);
  else if (action === "pair") {
    const result = await browserRequest(connection, "/api/browser/profiles/default/pair", {});
    console.log(`Pairing code: ${result.code}\nExpires: ${new Date(result.expiresAt).toISOString()}\nOpen Pi Agent Browse Settings, choose Local relay, enter 127.0.0.1:${port}, paste the code and Connect. Once connected, Chrome is ready to use from any local Pi Profile.`);
  } else if (action === "unpair") {
    await browserRequest(connection, "/api/browser/local/unpair", {});
    console.log("All local Chrome pairings removed.");
  } else if (action === "stop") {
    await browserRequest(connection, stop, {});
    console.log("Shared browser relay is stopping for all profiles.");
  } else console.log(JSON.stringify(status, null, 2));
}

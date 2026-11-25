"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";

type BrowserStatus = { available: boolean; pairingPending: boolean; browsers: { id: string; connected: boolean; tabs: number }[] };
async function request(path: string, method = "GET", signal?: AbortSignal) {
  const response = await fetch(`/api/pi/browser/${path}`, { method, cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? data.error ?? "Browser request failed");
  return data;
}
function RemoteBrowserProfile({ profile }: { profile: string }) {
  const [status, setStatus] = useState<BrowserStatus>();
  const [code, setCode] = useState<{ code: string; expiresAt: number }>();
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = `profiles/${encodeURIComponent(profile)}`;
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    const refresh = async () => {
      if (fetching) return; fetching = true;
      try { setStatus(await request(`${path}/status`, "GET", controller.signal)); setError(""); }
      catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
      finally { fetching = false; }
    };
    void refresh();
    const poll = setInterval(() => { void refresh(); setNow(Date.now()); }, 5000);
    return () => { controller.abort(); clearInterval(poll); };
  }, [path]);
  const act = async (action: "pair" | "unpair") => {
    setBusy(true); setError(""); setCode(undefined);
    try {
      const data = await request(`${path}/${action}`, "POST");
      if (action === "pair") { setCode(data); setNow(Date.now()); }
      setStatus(await request(`${path}/status`));
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="space-y-3">
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {!status ? <p role="status" className="text-sm text-zinc-500">Checking remote pairing…</p> : !status.available ?
      <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">Remote pairing is unavailable. Configure the Pi API public HTTPS origin and proxy WebSocket upgrades for /api/browser/connect. Local pairing below works without a public address.</p> : <>
        <p className="text-sm text-zinc-500">Generate a code here, then open the extension on the Chrome computer, choose <strong>Remote server</strong>, paste the code and Connect. No local relay is required on that computer. Download the ZIP from this server to embed its address.</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void act("pair")}>Generate pairing code</Button>
        </div>
        {code && <div role="status" className="rounded-md border p-3 text-sm">
          {now >= code.expiresAt ? <p>Pairing code expired. Generate a new code.</p> : !status.pairingPending ? <p>Pairing code used or invalidated. Check the browser connection below.</p> : <><p className="font-mono text-2xl">{code.code}</p><p>One use. Expires at {new Date(code.expiresAt).toLocaleTimeString()}. Generating another code replaces this one.</p><Button onClick={() => void navigator.clipboard.writeText(code.code).catch(() => setError("Select the code above and copy it manually."))}>Copy code</Button></>} 
        </div>}
      </>}
    {status && (status.browsers.length > 0 || status.pairingPending) && <Button disabled={busy} onClick={() => { if (window.confirm(`Revoke pending codes and all browser connections for ${profile}?`)) void act("unpair"); }}>Revoke browser access</Button>}
    <ul className="space-y-1 text-sm">{status?.browsers.map(browser => <li key={browser.id}><code>{browser.id}</code> — {browser.connected ? "Connected" : "Disconnected"} · {browser.tabs} agent tabs</li>)}</ul>
    <p className="text-sm text-zinc-500">Browser access is limited to the selected Pi Profile. Revocation disconnects existing sessions; restarting the server requires browser reconnection. Personal tabs are not automatically exposed.</p>
  </div>;
}
export function BrowserPairingPanel() {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profile, setProfile] = useState("default");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/pi/profiles", { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("Could not load Pi Profiles");
      const data = await response.json(); setProfiles(data.profiles.map((item: { name: string }) => item.name));
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, []);
  const command = profile === "default" ? "pi browser" : `pi profile ${profile} browser`;
  return <Card className="space-y-5">
    <CardTitle>Connect Chrome</CardTitle>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <div className="space-x-2"><label htmlFor="browser-profile" className="text-sm font-medium">Pi Profile</label><select id="browser-profile" className="rounded-md border p-2 text-sm" value={profile} onChange={event => setProfile(event.target.value)}>{(profiles.length ? profiles : ["default"]).map(name => <option key={name}>{name}</option>)}</select></div>
    <section className="space-y-2">
      <h3 className="font-medium">Pi and Chrome on this computer</h3>
      <p className="text-sm text-zinc-500">Install Pi on the Chrome computer with <code>npm install -g @earendil-works/pi-coding-agent</code>, then <code>pi install npm:pi-feats</code>. The relay uses Pi&apos;s existing Node runtime; no separate native binary, sudo, or incoming public port is required. Linux is validated; macOS/Windows platform smoke tests are pending.</p>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Install the extension using the ZIP above.</li>
        <li>In a terminal on that same computer, run <code>{command} install</code>, then <code>{command} pair</code>. Pair also installs/starts the relay automatically.</li>
        <li>In extension Settings, choose <strong>Local relay</strong>. Copy the exact address and pairing code printed by the CLI, then Connect.</li>
        <li>Check with <code>{command} status</code>. Use <code>{command} unpair</code> to revoke access or <code>{command} stop</code> to stop the relay.</li>
      </ol>
      <p className="text-sm text-zinc-500">For a named profile, create it on the local machine first. State and pairing credentials stay in that profile; runtime code is shared. After a Pi update, run install or pair to restart an outdated relay while preserving existing browser credentials. If the previous native relay owns port 20087, stop it before starting this relay.</p>
    </section>
    <section className="space-y-2"><h3 className="font-medium">Pi on another server</h3><RemoteBrowserProfile key={profile} profile={profile}/></section>
  </Card>;
}

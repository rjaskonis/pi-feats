"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";

type BrowserStatus = { available: boolean; pairingPending: boolean; browsers: { id: string; connected: boolean; tabs: number }[] };
async function request(path: string, method = "GET", signal?: AbortSignal) {
  const response = await fetch(`/api/pi/browser/${path}`, { method, cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? data.error ?? "Browser request failed");
  return data;
}
function CopyPairingCode({ code }: { code: string }) {
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (notice !== "Code copied.") return;
    const timer = window.setTimeout(() => setNotice(""), 2000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setNotice("Code copied.");
    } catch { setNotice("Could not copy. Select the code above and copy it manually."); }
  }
  const copied = notice === "Code copied.";
  return <>
    <Button type="button" className="inline-flex items-center gap-2" onClick={() => void copy()}>
      {copied ? <Check size={16} aria-hidden="true"/> : <Copy size={16} aria-hidden="true"/>}
      {copied ? "Copied" : "Copy code"}
    </Button>
    <span role="status" className="ml-2 text-sm">{notice}</span>
  </>;
}
function RemoteBrowserPairing() {
  const [status, setStatus] = useState<BrowserStatus>();
  const [code, setCode] = useState<{ code: string; expiresAt: number }>();
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = "shared";
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
      <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">Remote pairing is unavailable. Configure the Pi API public HTTPS origin and proxy WebSocket upgrades for /api/browser/connect. Local pairing works without a public address.</p> : <>
        <p className="text-sm text-zinc-500">Generate a code here, then open the extension on the Chrome computer, choose <strong>Remote server</strong>, paste the code and Connect. No local relay is required on that computer. Download the ZIP from this server to embed its address.</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void act("pair")}>Generate pairing code</Button>
        </div>
        {code && <div role="status" className="rounded-md border p-3 text-sm">
          {now >= code.expiresAt ? <p>Pairing code expired. Generate a new code.</p> : !status.pairingPending ? <p>Pairing code used or invalidated. Check the browser connection below.</p> : <><p className="font-mono text-2xl">{code.code}</p><p>One use. Expires at {new Date(code.expiresAt).toLocaleTimeString()}. Generating another code replaces this one.</p><CopyPairingCode key={code.code} code={code.code}/></>}
        </div>}
      </>}
    {status && (status.browsers.length > 0 || status.pairingPending) && <Button disabled={busy} onClick={() => { if (window.confirm("Revoke all remote browser connections and pending codes for this server?")) void act("unpair"); }}>Revoke browser access</Button>}
    <ul className="space-y-1 text-sm">{status?.browsers.map(browser => <li key={browser.id}><code>{browser.id}</code> — {browser.connected ? "Connected" : "Disconnected"}</li>)}</ul>
    <p className="text-sm text-zinc-500">Each Pi Profile can control only the tabs it opens. Profiles using the same Chrome profile share its website logins.</p>
  </div>;
}
export function BrowserPairingPanel() {
  return <Card className="space-y-5">
    <CardTitle>Connect Chrome</CardTitle>
    <section className="space-y-2">
      <h3 className="font-medium">Pi and Chrome on this computer</h3>
      <p className="text-sm text-zinc-500">Install Pi on the Chrome computer with <code>npm install -g @earendil-works/pi-coding-agent</code>, then <code>pi install npm:pi-feats</code>. The relay uses Pi&apos;s existing Node runtime; no separate native binary, sudo, or incoming public port is required. Linux is validated; macOS/Windows platform smoke tests are pending.</p>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Install the extension using the ZIP above.</li>
        <li>In a terminal outside any named profile, run <code>pi browser pair</code>. This starts the shared relay and prints a code. Skip this step if Chrome is already paired with the shared relay.</li>
        <li>In extension Settings, choose <strong>Local relay</strong>. Copy the address and code printed by the CLI, then click <strong>Connect</strong>.</li>
      </ol>
      <p className="text-sm">Once connected, Chrome is ready to use from any local Pi Profile. No profile selection or extra setup is needed. Each profile can operate only the tabs it opens.</p>
    </section>
    <section className="space-y-2 border-t pt-4">
      <h3 className="font-medium">Pi on another server</h3>
      <p className="text-sm">Pair Chrome once to make it available to all Pi Profiles on this server. Only pair browsers you intend to share with those profiles.</p>
      <RemoteBrowserPairing/>
    </section>
  </Card>;
}

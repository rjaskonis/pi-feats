"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BrowserPairingPanel } from "@/components/browser-pairing-panel";

type Status = { available: true; url: string } | { available: false; reason: string };

export function BrowserDownloadPanel() {
  const [status, setStatus] = useState<Status>();
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/pi/browser/download-status", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not check the download. Check that the Pi API is running and reload this page.");
        const result = await response.json() as Status;
        setStatus(result.available ? { ...result, url: new URL(result.url, window.location.origin).href } : result);
      })
      .catch((error: Error) => { if (!controller.signal.aborted) setStatus({ available: false, reason: error.message }); });
    return () => controller.abort();
  }, []);

  return <div className="space-y-4"><Card className="space-y-4">
    <div>
      <CardTitle>Pi Agent Browse</CardTitle>
      <p className="mt-1 text-sm text-zinc-500">Anyone with the public link can download the Chrome extension. The link does not grant access to a browser or Pi profile.</p>
    </div>
    {!status ? <p role="status" className="text-sm text-zinc-500">Checking download availability…</p> : !status.available ?
      <p role="status" className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">{status.reason}</p> :
      <div className="space-y-2">
        <label htmlFor="browser-download-url" className="text-sm font-medium">Public download link</label>
        <Input id="browser-download-url" readOnly value={status.url} onFocus={(event) => event.currentTarget.select()}/>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => void navigator.clipboard.writeText(status.url).then(() => setNotice("Link copied."), () => setNotice("Select the URL above and copy it manually."))}>Copy link</Button>
          <a href={status.url} className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-100">Download ZIP</a>
          <span role="status" className="text-sm text-zinc-500">{notice}</span>
        </div>
      </div>}
    <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-700">
      <li>Download and extract the ZIP.</li>
      <li>Open <code>chrome://extensions</code> and enable Developer mode.</li>
      <li>Choose <strong>Load unpacked</strong> and select the extracted folder containing <code>manifest.json</code>.</li>
    </ol>
  </Card><BrowserPairingPanel/></div>;
}

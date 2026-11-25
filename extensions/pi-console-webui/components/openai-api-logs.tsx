"use client";

import { useEffect, useState } from "react";
import { Filter, Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { OpenAICallLog, OpenAICallLogPage } from "../../lib/openai-call-log-types";

const endpoints = { "/v1/chat/completions": "Chat Completions", "/v1/responses": "Responses" } as const;
const outcomes = { success: "Success", error: "Error", aborted: "Disconnected" } as const;
const outcomeColors = { success: "text-emerald-700", error: "text-red-700", aborted: "text-amber-700" };
const filterClass = "h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm font-normal";
const quietButton = "bg-zinc-100 text-zinc-700 hover:bg-zinc-200";

export function OpenAIApiLogs() {
  const [filters, setFilters] = useState("");
  const [cursors, setCursors] = useState([""]);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<OpenAICallLogPage>();
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState("");
  const cursor = cursors.at(-1) ?? "";

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(filters);
    if (cursor) params.set("before", cursor);
    setPage(undefined);
    setError("");
    void (async () => {
      try {
        const response = await fetch(`/api/pi/openai-api-logs?${params}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`Could not load compatible API calls (HTTP ${response.status}).`);
        const result = await response.json() as OpenAICallLogPage;
        if (!controller.signal.aborted) setPage(result);
      } catch (cause) {
        if (!controller.signal.aborted) setError((cause as Error).message);
      }
    })();
    return () => controller.abort();
  }, [filters, cursor, revision]);

  const selected = page?.calls.find(({ id }) => id === selectedId) ?? page?.calls[0];
  const details = (call: OpenAICallLog) => [
    ["Request ID", call.id], ["Received", new Date(call.receivedAt).toLocaleString()], ["Method and endpoint", `POST ${call.endpoint}`],
    ["Profile", call.profile ?? "Not available"], ["Outcome", outcomes[call.outcome]], ["HTTP status", call.httpStatus ?? "Not sent"],
    ["Delivery", call.stream === null ? "Not available" : call.stream ? "Streaming (SSE)" : "JSON"],
    ["Duration", `${call.durationMs.toLocaleString()} ms`], ["Error code", call.errorCode ?? "—"],
  ];

  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-semibold">Direct Compatible API</h2><p className="text-sm text-zinc-500">Chat Completions and Responses requests received directly by Pi, outside Applications. Only metadata is recorded; the latest 5,000 calls are retained.</p></div>
      <Button className={quietButton} onClick={() => { setCursors([""]); setRevision((value) => value + 1); }}><RotateCw size={16} className="mr-2"/>Refresh</Button>
    </div>
    <Card className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold"><Filter size={16} className="text-emerald-600"/>Log filters</div>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
        event.preventDefault();
        const params = new URLSearchParams();
        for (const [key, value] of new FormData(event.currentTarget)) if (String(value).trim()) params.set(key, String(value).trim());
        setFilters(params.toString()); setCursors([""]); setSelectedId(undefined); setRevision((value) => value + 1);
      }}>
        <label className="grid gap-1 text-sm font-medium">Endpoint<select name="endpoint" className={filterClass}><option value="">All endpoints</option>{Object.entries(endpoints).map(([path, label]) => <option key={path} value={path}>{label}</option>)}</select></label>
        <label className="grid gap-1 text-sm font-medium">Profile<Input name="profile" className="h-10 font-normal" placeholder="All profiles" maxLength={64}/></label>
        <label className="grid gap-1 text-sm font-medium">Outcome<select name="outcome" className={filterClass}><option value="">All outcomes</option>{Object.entries(outcomes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <Button type="submit">Apply filters</Button>
      </form>
    </Card>
    <div className="grid gap-4 lg:grid-cols-[minmax(280px,1fr)_minmax(340px,2fr)]">
      <Card>
        <CardTitle>Calls</CardTitle>
        <div className="mt-3 max-h-[550px] space-y-2 overflow-auto">
          {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !page ? <p role="status" className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 size={16} className="animate-spin"/>Loading log calls…</p> : page.calls.length === 0 ? <p className="text-sm text-zinc-500">No calls match the filters.</p> : page.calls.map((call) =>
            <button key={call.id} type="button" onClick={() => setSelectedId(call.id)} aria-pressed={selected?.id === call.id} className={`w-full rounded-lg border p-3 text-left text-sm ${selected?.id === call.id ? "border-emerald-400 bg-emerald-50" : "border-zinc-200 hover:bg-zinc-50"}`}>
              <span className="block font-semibold">{endpoints[call.endpoint]}</span>
              <span className="block break-all text-zinc-500">{new Date(call.receivedAt).toLocaleString()} · {call.profile ?? "Unknown profile"}</span>
              <span className={outcomeColors[call.outcome]}>{outcomes[call.outcome]}{call.httpStatus === null ? "" : ` · HTTP ${call.httpStatus}`}</span>
            </button>)}
        </div>
        {(cursors.length > 1 || page?.next) && <div className="mt-4 flex flex-wrap gap-2">
          <Button className={quietButton} disabled={cursors.length < 2} onClick={() => setCursors(cursors.slice(0, -1))}>Newer</Button>
          <Button className={quietButton} disabled={!page?.next} onClick={() => { if (page?.next) setCursors([...cursors, page.next]); }}>Older</Button>
        </div>}
      </Card>
      <Card>
        <CardTitle>Details</CardTitle>
        {selected ? <dl className="mt-4 divide-y divide-zinc-100 text-sm">{details(selected).map(([label, value]) => <div key={label} className="grid gap-1 py-2 sm:grid-cols-[9rem_1fr]"><dt className="font-medium text-zinc-500">{label}</dt><dd className="break-all text-zinc-900">{value}</dd></div>)}</dl> : <p className="mt-4 text-sm text-zinc-500">Select a call to inspect its metadata.</p>}
      </Card>
    </div>
  </div>;
}

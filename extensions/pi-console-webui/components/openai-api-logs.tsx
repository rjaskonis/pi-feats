"use client";

import { useEffect, useRef, useState } from "react";
import { Filter, Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { FlowArrow, JsonView, localDateTime } from "@/components/application-logs";
import type { CallStageId, OpenAICallDetail, OpenAICallLogPage, OpenAICallSummary } from "../../lib/openai-call-log-types";

const base = "/api/pi/openai-api-logs";
const endpoints = { "/v1/chat/completions": "Chat Completions", "/v1/responses": "Responses" } as const;
const outcomes = { running: "Running", success: "Success", error: "Error", aborted: "Disconnected" } as const;
const outcomeColors = { running: "text-sky-700", success: "text-emerald-700", error: "text-red-700", aborted: "text-amber-700" };
const stages = {
  request: { title: "Request", detail: "Request payload", color: "border-sky-400 bg-sky-50 text-sky-800" },
  validation: { title: "Validation & Profile", detail: "Routing and validation", color: "border-amber-400 bg-amber-50 text-amber-800" },
  execution: { title: "Pi Execution", detail: "Pi execution", color: "border-indigo-400 bg-indigo-50 text-indigo-800" },
  response: { title: "Response", detail: "Response body", color: "border-teal-400 bg-teal-50 text-teal-800" },
};
const filterClass = "h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm font-normal";
const chipColors: Record<string, string> = {
  "/v1/chat/completions": "border-sky-400 bg-sky-50 text-sky-700",
  "/v1/responses": "border-violet-400 bg-violet-50 text-violet-700",
  success: "border-emerald-400 bg-emerald-50 text-emerald-700",
  error: "border-red-400 bg-red-50 text-red-700",
  running: "border-cyan-400 bg-cyan-50 text-cyan-700",
  aborted: "border-amber-400 bg-amber-50 text-amber-800",
};
const toggle = (values: string[], value: string) => values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
const hour = 60 * 60 * 1000;
const quietButton = "bg-zinc-100 text-zinc-700 hover:bg-zinc-200";
const duration = (ms: number) => `${ms.toLocaleString()} ms`;

// Coalesce bursts without aborting a request already in flight. Only a change
// of filter, page or selection cancels a fetch.
function useLogResource<T>(path?: string) {
  const [state, setState] = useState<{ path?: string; data?: T; error?: string }>({});
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, loading = false, dirty = false;
    const invalidate = () => {
      dirty = true;
      if (!loading && timer === undefined) timer = setTimeout(() => { timer = undefined; void load(); }, 350);
    };
    async function load() {
      loading = true; dirty = false;
      try {
        const response = await fetch(path!, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(typeof body?.error === "string" ? body.error : `Request failed (HTTP ${response.status}).`);
        }
        const data = await response.json() as T;
        if (!controller.signal.aborted) setState({ path, data });
      } catch (cause) {
        if (!controller.signal.aborted) setState((previous) => ({ path, data: previous.path === path ? previous.data : undefined, error: (cause as Error).message }));
      } finally {
        loading = false;
        if (dirty && !controller.signal.aborted) invalidate();
      }
    }
    refresh.current = invalidate;
    void load();
    return () => { controller.abort(); clearTimeout(timer); refresh.current = () => {}; };
  }, [path]);
  return { ...(state.path === path ? state : {}), refresh };
}

export function OpenAIApiLogs({ profiles }: { profiles: Array<{ name: string }> }) {
  const [dateRange, setDateRange] = useState<{ start: string; end: string }>();
  const { start = "", end = "" } = dateRange ?? {};
  useEffect(() => {
    const now = Date.now();
    setDateRange({ start: localDateTime(new Date(now - 3 * hour)), end: localDateTime(new Date(now + hour)) });
  }, []);
  const [endpointFilter, setEndpointFilter] = useState<string[]>([]);
  const [outcomeFilter, setOutcomeFilter] = useState<string[]>([]);
  const [profileFilter, setProfileFilter] = useState("");
  const [cursors, setCursors] = useState([""]);
  const [selectedId, setSelectedId] = useState<string>();
  const [stageId, setStageId] = useState<CallStageId>();
  const [connected, setConnected] = useState(false);
  const cursor = cursors.at(-1) ?? "";
  const params = new URLSearchParams();
  if (endpointFilter.length) params.set("endpoint", endpointFilter.join(","));
  if (outcomeFilter.length) params.set("outcome", outcomeFilter.join(","));
  if (profileFilter) params.set("profile", profileFilter);
  const startMs = start ? Date.parse(start) : undefined, endMs = end ? Date.parse(end) : undefined;
  const invalidRange = (startMs !== undefined && !Number.isFinite(startMs)) || (endMs !== undefined && !Number.isFinite(endMs)) || (startMs !== undefined && endMs !== undefined && startMs > endMs);
  if (!invalidRange) {
    if (startMs !== undefined) params.set("start", new Date(startMs).toISOString());
    if (endMs !== undefined) params.set("end", new Date(endMs).toISOString());
  }
  if (cursor) params.set("before", cursor);
  const list = useLogResource<OpenAICallLogPage>(!dateRange || invalidRange ? undefined : `${base}?${params}`);
  const firstId = list.data?.calls[0]?.id;
  useEffect(() => { if (!selectedId && firstId) setSelectedId(firstId); }, [selectedId, firstId]);
  const id = selectedId ?? firstId;
  const detail = useLogResource<OpenAICallDetail>(!invalidRange && id ? `${base}/calls/${encodeURIComponent(id)}` : undefined);
  const live = useRef({ cursor, id });
  useEffect(() => { live.current = { cursor, id }; }, [cursor, id]);
  const refreshList = list.refresh, refreshDetail = detail.refresh;
  useEffect(() => {
    const events = new EventSource(`${base}/stream`);
    events.onopen = () => { setConnected(true); refreshList.current(); refreshDetail.current(); };
    events.onerror = () => setConnected(false);
    events.onmessage = ({ data }) => {
      if (!live.current.cursor) refreshList.current();
      if (data === JSON.stringify(live.current.id)) refreshDetail.current();
    };
    return () => events.close();
  }, [refreshList, refreshDetail]);

  const resetSelection = () => { setSelectedId(undefined); setStageId(undefined); };
  const resetFilters = () => { setCursors([""]); resetSelection(); };
  const call = detail.data?.call;
  const flow = detail.data?.stages;
  const current = flow?.find(({ id }) => id === stageId) ?? flow?.at(-1);
  const setDate = (key: "start" | "end", value: string) => { setDateRange({ start, end, [key]: value }); resetFilters(); };
  const chip = (value: string, label: string, selected: boolean, onClick: () => void) => <button key={value} type="button" aria-pressed={selected} onClick={onClick}
    className={`rounded-full border px-3 py-1 text-xs font-medium transition ${chipColors[value]} ${selected ? "ring-2 ring-offset-1 ring-zinc-400" : "opacity-70 hover:opacity-100"}`}>{label}</button>;
  const calls = list.data?.calls ?? [];
  const visibleCalls = call && !calls.some(({ id }) => id === call.id) ? [call, ...calls] : calls;

  const callButton = (entry: OpenAICallSummary) => <button key={entry.id} type="button" aria-pressed={entry.id === id}
    className={`w-full rounded-lg border p-3 text-left text-sm ${entry.id === id ? "border-emerald-400 bg-emerald-50" : "border-zinc-200 hover:bg-zinc-50"}`}
    onClick={() => { setSelectedId(entry.id); setStageId(undefined); }}>
    <b>{new Date(entry.receivedAt).toLocaleString()}</b><p className="truncate text-zinc-500">{endpoints[entry.endpoint]} · {entry.profile ?? "Unknown profile"}</p>
    <p className={outcomeColors[entry.outcome]}>{outcomes[entry.outcome]}{entry.httpStatus === null ? "" : ` · HTTP ${entry.httpStatus}`}</p>
    {entry.errorCode && <p className="mt-1 truncate text-xs text-red-700">{entry.errorCode}</p>}
  </button>;

  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-semibold">Direct Compatible API</h2><p className="text-sm text-zinc-500">Chat Completions and Responses requests received directly by Pi, outside Applications.</p></div>
      <div className="flex items-center gap-3"><span role="status" className={`text-xs font-medium ${connected ? "text-emerald-700" : "text-amber-700"}`}>{connected ? "Live" : "Connecting to live updates…"}</span>
        <Button className={quietButton} onClick={() => { refreshList.current(); refreshDetail.current(); }} title="Refresh logs"><RotateCw size={16}/></Button></div>
    </div>
    <Card className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold"><Filter size={16} className="text-emerald-600"/>Log filters</div>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Endpoint" className="flex flex-wrap gap-2">{Object.entries(endpoints).map(([value, label]) => chip(value, label, endpointFilter.includes(value), () => { setEndpointFilter((previous) => toggle(previous, value)); resetFilters(); }))}</div>
        <div role="group" aria-label="Outcome" className="flex flex-wrap gap-2">{(["success", "error", "running", "aborted"] as const).map((value) => chip(value, value === "error" ? "Errors" : outcomes[value], outcomeFilter.includes(value), () => { setOutcomeFilter((previous) => toggle(previous, value)); resetFilters(); }))}</div>
      </div>
      <div className="grid max-w-4xl gap-4 sm:grid-cols-3">
        <label className="grid gap-1 text-sm font-medium">Start (browser time)<input type="datetime-local" value={start} className={filterClass} onChange={(event) => setDate("start", event.target.value)}/></label>
        <label className="grid gap-1 text-sm font-medium">End (browser time)<input type="datetime-local" value={end} className={filterClass} onChange={(event) => setDate("end", event.target.value)}/></label>
        <label className="grid gap-1 text-sm font-medium">Profile<select className={filterClass} value={profileFilter} onChange={(event) => { setProfileFilter(event.target.value); resetFilters(); }}><option value="">All profiles</option>{profiles.map(({ name }) => <option key={name} value={name}>{name}</option>)}</select></label>
      </div>
      {invalidRange && <p role="alert" className="text-sm text-red-700">Enter a valid date range with the start before the end.</p>}
    </Card>
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)_minmax(0,1fr)]">
      <Card className="max-h-[650px] overflow-auto">
        <CardTitle>Calls</CardTitle><div className="mt-3 space-y-2">
          {list.error && <p role="alert" className="text-sm text-red-700">{list.error}</p>}
          {!list.data && !list.error && !invalidRange && <p role="status" className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 size={16} className="animate-spin"/>Loading log calls…</p>}
          {list.data && visibleCalls.length === 0 && <p className="text-sm text-zinc-500">No calls match the filters.</p>}
          {visibleCalls.map(callButton)}
        </div>
        {(cursors.length > 1 || list.data?.next) && <div className="mt-4 flex flex-wrap gap-2">
          <Button className={quietButton} disabled={cursors.length < 2} onClick={() => { setCursors(cursors.slice(0, -1)); resetSelection(); }}>Newer</Button>
          <Button className={quietButton} disabled={!list.data?.next} onClick={() => { if (list.data?.next) { setCursors([...cursors, list.data.next]); resetSelection(); } }}>Older</Button>
        </div>}
      </Card>
      <Card className="max-h-[650px] overflow-auto">
        <CardTitle>Workflow</CardTitle><div className="mt-4 space-y-2">
          {detail.error && <p role="alert" className="text-sm text-red-700">{detail.error}</p>}
          {id && !detail.data && !detail.error && <p className="text-sm text-zinc-500">Loading call details…</p>}
          {!id && <p className="text-sm text-zinc-500">Select a call to inspect its workflow.</p>}
          {flow === null && <p className="rounded-lg border border-zinc-200 p-3 text-sm text-zinc-500">Only metadata is available for this call. Workflow details were not captured or have expired.</p>}
          {flow?.map((stage, index) => <div key={stage.id}>
            <button type="button" aria-pressed={current?.id === stage.id} onClick={() => { setSelectedId(id); setStageId(stage.id); }} className={`w-full rounded-lg border p-3 text-left ${stage.outcome === "error" ? "border-red-300 bg-red-50 text-red-800" : stages[stage.id].color} ${current?.id === stage.id ? "ring-2 ring-offset-1 ring-zinc-400" : "hover:brightness-95"}`}>
              <b>{stages[stage.id].title}</b><p className="text-xs opacity-80">{outcomes[stage.outcome]}{stage.durationMs === null ? "" : ` · ${duration(stage.durationMs)}`}</p>
            </button>
            {index < flow.length - 1 && <FlowArrow output={stage.data?.value} nextInput={flow[index + 1].data?.value}/>}
          </div>)}
        </div>
      </Card>
      <Card className="max-h-[650px] overflow-auto">
        <CardTitle>Details</CardTitle>
        {call ? <div className="mt-4 space-y-4">
          <div className="rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600">
            <p className="font-medium">POST {call.endpoint}</p><p className="break-all">{call.id}</p>
            <p>{call.profile ?? "Unknown profile"} · {outcomes[call.outcome]}{call.stream === null ? "" : call.stream ? " · SSE" : " · JSON"}{call.httpStatus === null ? "" : ` · HTTP ${call.httpStatus}`}{call.durationMs === null ? "" : ` · ${duration(call.durationMs)}`}</p>
            {call.errorCode && <p className="font-medium text-red-700">{call.errorCode}</p>}
          </div>
          {current ? <section>
            <p className="mb-2 text-sm font-medium">{stages[current.id].detail}</p>
            {current.data ? <><JsonView value={current.data.value}/>{current.data.limited && <p className="mt-2 text-xs text-amber-700">Some values were omitted, redacted, or truncated.</p>}</> : <p className="text-sm text-zinc-500">No payload for this stage.</p>}
          </section> : null}
        </div> : <p className="mt-4 text-sm text-zinc-500">Select a call and a stage to inspect its data.</p>}
      </Card>
    </div>
  </div>;
}

"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Check, Copy, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/toast";

type Settings = { inboundHandler: string; outboundHandler?: string; transformHandlers?: string[]; messageCoalescing?: { enabled?: boolean; silenceDebounceSeconds?: number } };
type App = { name: string; slug: string; enabled: boolean; responseMode: "ack" | "result"; defaultProfile: string | null; routingPolicy: "default_as_fallback" | "drop"; settings: Settings };
type HandlerOptions = { inbound: string[]; outbound: string[]; transform: string[] };
const api = async (path: string, init?: RequestInit) => { const response = await fetch(`/api/pi/${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } }); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error?.message ?? "Request failed"); return response.json(); };
const handlerName = (path: string) => path.replace(/^transforms\//, "").replace(/\.ts$/, "");

export function ApplicationSettings({ slug }: { slug: string }) {
  const { toast } = useToast(); const router = useRouter(), isNew = slug === "new";
  const [app, setApp] = useState<App>();
  const [profiles, setProfiles] = useState<string[]>([]);
  const [handlers, setHandlers] = useState<HandlerOptions>({ inbound: [], outbound: [], transform: [] });
  const [saving, setSaving] = useState(false), [error, setError] = useState(""), [copyMenu, setCopyMenu] = useState(false);
  useEffect(() => {
    if (isNew) { api("profiles").then((profileData) => { setProfiles(profileData.profiles.map((item: { name: string }) => item.name)); setApp({ name: "", slug: "", enabled: true, responseMode: "ack", defaultProfile: null, routingPolicy: "default_as_fallback", settings: { inboundHandler: "inbound", transformHandlers: [] } }); setHandlers({ inbound: ["inbound"], outbound: [], transform: [] }); }).catch((cause) => setError(cause.message)); return; }
    Promise.all([api(`applications/${slug}`), api("profiles"), api(`applications/${slug}/handlers`)]).then(([application, profileData, handlerData]) => { setApp(application.application); setProfiles(profileData.profiles.map((item: { name: string }) => item.name)); const files = handlerData.files as string[]; const regular = files.filter((file) => !file.startsWith("transforms/")).map(handlerName); setHandlers({ inbound: regular, outbound: regular, transform: files.filter((file) => file.startsWith("transforms/")).map(handlerName) }); }).catch((cause) => setError(cause.message));
  }, [slug, isNew]);
  if (!app) return <Card>{error || "Loading Application settings…"}</Card>;

  const settings = app.settings;
  const update = (patch: Partial<App>) => setApp({ ...app, ...patch });
  const updateSettings = (patch: Partial<Settings>) => update({ settings: { ...settings, ...patch } });
  const transformHandlers = settings.transformHandlers ?? [];
  const moveTransform = (from: number, to: number) => { if (to < 0 || to >= transformHandlers.length) return; const next = [...transformHandlers]; [next[from], next[to]] = [next[to], next[from]]; updateSettings({ transformHandlers: next }); };
  const setTransform = (index: number, value: string) => { const next = [...transformHandlers]; next[index] = value; updateSettings({ transformHandlers: next }); };
  const save = async () => { try { setSaving(true); setError(""); if (isNew) { const result = await api("applications", { method: "POST", body: JSON.stringify(app) }); toast("Application created."); router.replace(`/applications/${encodeURIComponent(result.application.slug)}?context=admin&tab=settings`); return; } const result = await api(`applications/${slug}`, { method: "PUT", body: JSON.stringify(app) }); setApp(result.application); toast("Application saved."); } catch (cause) { const message = (cause as Error).message; setError(message); toast(message, "error"); } finally { setSaving(false); } };
  const copy = async (format: "url" | "curl") => { const url = `${window.location.origin}/api/message/app/${app.slug}`; try { await navigator.clipboard.writeText(format === "url" ? url : `curl --request POST '${url}' \\\n  --header 'Content-Type: application/json' \\\n  --data '{"message":"Hello"}'`); toast(format === "url" ? "Application URL copied." : "Example cURL copied."); } catch { toast("Unable to copy to the clipboard.", "error"); } };
  const renderHandlerOptions = (available: string[], current?: string, blank = "Select a handler") => <>{!current && <option value="">{blank}</option>}{current && !available.includes(current) && <option value={current}>{current} (missing)</option>}{available.map((name) => <option key={name} value={name}>{name}</option>)}</>;

  return <div className="space-y-5">
    {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <Card className="grid gap-4 md:grid-cols-2">
      <div className="flex items-center justify-between gap-3 md:col-span-2"><CardTitle>{isNew ? "Create Application" : "General"}</CardTitle><div className="flex gap-2"><div className="relative"><Button className="bg-zinc-100 text-zinc-700 hover:bg-zinc-200" title="Copy public endpoint" aria-expanded={copyMenu} onClick={() => setCopyMenu((open) => !open)}><Copy size={17}/></Button>{copyMenu && <div className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg"><button className="w-full rounded px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100" onClick={() => { setCopyMenu(false); void copy("url"); }}>Simply Application URL</button><button className="w-full rounded px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100" onClick={() => { setCopyMenu(false); void copy("curl"); }}>Example cURL</button></div>}</div><Button className="!bg-[#2bbb77] hover:!bg-[#249b63]" title="Save Application" disabled={saving} onClick={save}>{saving ? <Loader2 className="animate-spin" size={17}/> : <Check size={17}/>}</Button></div></div>
      <label className="text-sm font-medium">Name<Input className="mt-1" value={app.name} onChange={(event) => update({ name: event.target.value })}/></label>
      <label className="text-sm font-medium">Slug{isNew ? <Input className="mt-1 font-mono" value={app.slug} placeholder="my-application" onChange={(event) => update({ slug: event.target.value.toLowerCase() })}/> : <div className="mt-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm">{app.slug}</div>}</label>
      <label className="text-sm font-medium">Public endpoint<div className="mt-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm">/api/message/app/{app.slug || "…"}</div></label>
      <label className="text-sm font-medium">Default profile<select className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2" value={app.defaultProfile ?? ""} onChange={(event) => update({ defaultProfile: event.target.value || null })}><option value="">None</option>{profiles.map((profile) => <option key={profile}>{profile}</option>)}</select></label>
      <label className="text-sm font-medium">Response mode<select className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2" value={app.responseMode} onChange={(event) => update({ responseMode: event.target.value as App["responseMode"] })}><option value="ack">Acknowledgement (ack)</option><option value="result">Wait for result</option></select></label>
      <label className="text-sm font-medium">Routing policy<select className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2" value={app.routingPolicy} onChange={(event) => update({ routingPolicy: event.target.value as App["routingPolicy"] })}><option value="default_as_fallback">Use default profile as fallback</option><option value="drop">Reject unresolved routes</option></select></label>
      <label className="flex items-center gap-2 text-sm font-medium md:col-span-2"><Switch checked={app.enabled} onCheckedChange={(enabled) => update({ enabled })}/>Enabled</label>
    </Card>
    <Card className="space-y-4">
      <div><CardTitle>Message coalescing</CardTitle><p className="mt-1 text-sm text-zinc-500">Collects messages from the same resolved identity after inbound handling. Only the last message after the silence interval dispatches the combined content to Pi.</p></div>
      <div className="grid gap-4 md:grid-cols-2"><label className="flex items-center gap-2 text-sm font-medium"><Switch checked={settings.messageCoalescing?.enabled === true} onCheckedChange={(enabled) => updateSettings({ messageCoalescing: { enabled, silenceDebounceSeconds: settings.messageCoalescing?.silenceDebounceSeconds ?? 10 } })}/>Enabled</label><label className="text-sm font-medium">Silence debounce (seconds)<Input className="mt-1" type="number" min="1" max="3600" disabled={!settings.messageCoalescing?.enabled} value={settings.messageCoalescing?.silenceDebounceSeconds ?? 10} onChange={(event) => updateSettings({ messageCoalescing: { enabled: settings.messageCoalescing?.enabled === true, silenceDebounceSeconds: Number(event.target.value) } })}/></label></div>
    </Card>
    <Card className="space-y-4">
      <div><CardTitle>Pipeline</CardTitle><p className="mt-1 text-sm text-zinc-500">{isNew ? "Save the Application before creating and selecting custom handlers." : "Handlers are managed in the Handlers tab. Transform order is execution order."}</p></div>
      <label className="block text-sm font-medium">Inbound handler<select className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2" value={settings.inboundHandler} onChange={(event) => updateSettings({ inboundHandler: event.target.value })}>{renderHandlerOptions(handlers.inbound, settings.inboundHandler)}</select></label>
      <label className="block text-sm font-medium">Outbound handler<select className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2" value={settings.outboundHandler ?? ""} onChange={(event) => updateSettings({ outboundHandler: event.target.value || undefined })}>{renderHandlerOptions(handlers.outbound, settings.outboundHandler, "None")}</select></label>
      <div><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-medium">Transform handlers</p><p className="text-xs text-zinc-500">They run from top to bottom before the inbound handler.</p></div><Button className="bg-zinc-100 text-zinc-700 hover:bg-zinc-200" title="Add transform handler" disabled={handlers.transform.length === 0 || transformHandlers.length >= handlers.transform.length} onClick={() => { const next = handlers.transform.find((name) => !transformHandlers.includes(name)); if (next) updateSettings({ transformHandlers: [...transformHandlers, next] }); }}><Plus size={16}/></Button></div>
        <div className="mt-3 space-y-2">{transformHandlers.map((handler, index) => <div className="flex gap-2" key={`${handler}-${index}`}><select className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-3 py-2" value={handler} onChange={(event) => setTransform(index, event.target.value)}>{renderHandlerOptions(handlers.transform.filter((name) => name === handler || !transformHandlers.includes(name)), handler)}</select><Button className="bg-zinc-100 text-zinc-700 hover:bg-zinc-200" title="Move transform up" disabled={index === 0} onClick={() => moveTransform(index, index - 1)}><ArrowUp size={16}/></Button><Button className="bg-zinc-100 text-zinc-700 hover:bg-zinc-200" title="Move transform down" disabled={index === transformHandlers.length - 1} onClick={() => moveTransform(index, index + 1)}><ArrowDown size={16}/></Button><Button className="bg-zinc-100 text-zinc-700 hover:bg-red-50 hover:text-red-700" title="Remove transform handler" onClick={() => updateSettings({ transformHandlers: transformHandlers.filter((_, item) => item !== index) })}><Trash2 size={16}/></Button></div>)}{handlers.transform.length === 0 && <p className="rounded-lg border border-dashed border-zinc-200 p-3 text-sm text-zinc-500">No transform handlers are registered. Create one in the Handlers tab.</p>}{handlers.transform.length > 0 && transformHandlers.length === 0 && <p className="text-sm text-zinc-500">No transforms configured.</p>}</div>
      </div>
    </Card>
  </div>;
}

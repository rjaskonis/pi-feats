"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/toast";

type Provider = { id: string; models: Array<{ id: string; name: string }> };
type ModelCatalog = { providers: Provider[] };
type ApplicationSession = { application: string; sessionPrefix: string; sessionId: string };

export function ProfileModelForm({ profile, initial }: { profile: string; initial?: ModelCatalog & { settings?: Record<string, unknown> } }) {
  const { toast } = useToast();
  const [catalog, setCatalog] = useState<ModelCatalog>({ providers: initial?.providers ?? [] });
  const [provider, setProvider] = useState(String(initial?.settings?.defaultProvider ?? initial?.providers[0]?.id ?? ""));
  const models = useMemo(() => catalog.providers.find((item) => item.id === provider)?.models ?? [], [catalog, provider]);
  const [model, setModel] = useState(String(initial?.settings?.defaultModel ?? ""));
  const [loading, setLoading] = useState(!initial), [saving, setSaving] = useState(false), [rollingOver, setRollingOver] = useState(false);
  const [rolloverDialog, setRolloverDialog] = useState(false), [activeSessions, setActiveSessions] = useState<ApplicationSession[]>([]);
  const load = async () => { try { setLoading(true); const response = await fetch(`/api/pi/profiles/${encodeURIComponent(profile)}/model`); const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Unable to load models"); setCatalog(body); setProvider((current) => current && body.providers.some((item: Provider) => item.id === current) ? current : body.providers[0]?.id ?? ""); } catch (error) { toast((error as Error).message, "error"); } finally { setLoading(false); } };
  useEffect(() => { if (!initial) { void load(); return; } setCatalog({ providers: initial.providers }); setProvider(String(initial.settings?.defaultProvider ?? initial.providers[0]?.id ?? "")); setModel(String(initial.settings?.defaultModel ?? "")); setLoading(false); }, [profile, initial]);
  useEffect(() => { if (!models.some((item) => item.id === model)) setModel(models[0]?.id ?? ""); }, [models, model]);
  const save = async () => {
    if (!provider || !model || saving) return;
    try {
      setSaving(true);
      const response = await fetch(`/api/pi/profiles/${encodeURIComponent(profile)}/model`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, model }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to save model");
      const sessionsResponse = await fetch(`/api/pi/application-sessions?${new URLSearchParams({ profile })}`);
      const sessionsBody = await sessionsResponse.json();
      if (!sessionsResponse.ok) throw new Error(sessionsBody.error ?? "Model saved, but active sessions could not be loaded.");
      const unique = new Map<string, ApplicationSession>();
      for (const session of sessionsBody.sessions as ApplicationSession[]) unique.set(`${session.application}:${session.sessionPrefix}`, session);
      setActiveSessions([...unique.values()]);
      setRolloverDialog(true);
    } catch (error) { toast((error as Error).message, "error"); } finally { setSaving(false); }
  };
  const later = () => { setRolloverDialog(false); toast("Model saved. It will be used by new sessions."); };
  const rollover = async () => {
    try {
      setRollingOver(true);
      const outcomes = await Promise.allSettled(activeSessions.map(async (session) => {
        const response = await fetch(`/api/pi/applications/${encodeURIComponent(session.application)}/session-rollover`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile, sessionPrefix: session.sessionPrefix }) });
        if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? "Unable to roll over session"); }
      }));
      const failed = outcomes.filter((outcome) => outcome.status === "rejected").length;
      setRolloverDialog(false);
      toast(failed ? `Model saved. ${activeSessions.length - failed} session(s) rolled over; ${failed} failed.` : "Model saved and active sessions rolled over.", failed ? "error" : "success");
    } finally { setRollingOver(false); }
  };
  return <><Card><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle>Model</CardTitle><p className="text-sm text-zinc-500">Choose the default provider and model for this profile.</p></div><Button className="!bg-[#2bbb77] hover:!bg-[#249b63]" title="Save model" disabled={loading || saving || !provider || !model} onClick={save}>{saving ? <Loader2 className="animate-spin" size={17}/> : <Save size={17}/>}</Button></div>{loading ? <div className="flex min-h-40 items-center justify-center gap-3 text-sm text-zinc-500"><Loader2 className="animate-spin" size={18}/>Loading models…</div> : <div className="mt-5 grid gap-4 md:grid-cols-2"><label className="grid gap-1.5 text-sm font-medium text-zinc-700">Provider<select className="rounded-md border border-zinc-200 px-3 py-2 font-normal" value={provider} onChange={(event) => setProvider(event.target.value)} disabled={catalog.providers.length === 0}>{catalog.providers.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><label className="grid gap-1.5 text-sm font-medium text-zinc-700">Model<select className="rounded-md border border-zinc-200 px-3 py-2 font-normal" value={model} onChange={(event) => setModel(event.target.value)} disabled={models.length === 0}>{models.map((item) => <option key={item.id} value={item.id}>{item.name === item.id ? item.id : `${item.name} (${item.id})`}</option>)}</select></label>{catalog.providers.length === 0 && <p className="text-sm text-zinc-500 md:col-span-2">No models are available for this profile.</p>}</div>}</Card>{rolloverDialog && <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-labelledby="rollover-title"><Card className="w-full max-w-lg"><h2 id="rollover-title" className="text-lg font-semibold">Roll over active sessions?</h2><p className="mt-2 text-sm text-zinc-600">The new model is saved and will be used by new sessions. Roll over active Application sessions now so they start using this model.</p>{activeSessions.length > 0 ? <ul className="mt-4 max-h-40 space-y-1 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">{activeSessions.map((session) => <li key={`${session.application}:${session.sessionPrefix}`}><span className="font-medium text-zinc-800">{session.application}</span> · {session.sessionPrefix}</li>)}</ul> : <p className="mt-4 text-sm text-zinc-500">There are no active Application sessions for this profile.</p>}<div className="mt-6 flex justify-end gap-2">{activeSessions.length > 0 && <Button className="!bg-[#2bbb77] hover:!bg-[#249b63]" title="Roll over active sessions" disabled={rollingOver} onClick={() => void rollover()}>{rollingOver ? <Loader2 className="animate-spin" size={17}/> : <RefreshCw size={17}/>}<span className="ml-2">Roll over now</span></Button>}<Button className="bg-zinc-100 text-zinc-700 hover:bg-zinc-200" title={activeSessions.length > 0 ? "Roll over later" : "Close"} disabled={rollingOver} onClick={later}>{activeSessions.length > 0 ? "Later" : "Close"}</Button></div></Card></div>}</>;
}

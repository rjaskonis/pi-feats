"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/toast";

type Provider = { id: string; models: Array<{ id: string; name: string }> };
type ModelCatalog = { providers: Provider[] };

export function ProfileModelForm({ profile, initial }: { profile: string; initial?: ModelCatalog & { settings?: Record<string, unknown> } }) {
  const { toast } = useToast();
  const [catalog, setCatalog] = useState<ModelCatalog>({ providers: initial?.providers ?? [] });
  const [provider, setProvider] = useState(String(initial?.settings?.defaultProvider ?? initial?.providers[0]?.id ?? ""));
  const models = useMemo(() => catalog.providers.find((item) => item.id === provider)?.models ?? [], [catalog, provider]);
  const [model, setModel] = useState(String(initial?.settings?.defaultModel ?? ""));
  const [loading, setLoading] = useState(!initial), [saving, setSaving] = useState(false);
  const load = async () => { try { setLoading(true); const response = await fetch(`/api/pi/profiles/${encodeURIComponent(profile)}/model`); const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Unable to load models"); setCatalog(body); setProvider((current) => current && body.providers.some((item: Provider) => item.id === current) ? current : body.providers[0]?.id ?? ""); } catch (error) { toast((error as Error).message, "error"); } finally { setLoading(false); } };
  useEffect(() => { if (!initial) { void load(); return; } setCatalog({ providers: initial.providers }); setProvider(String(initial.settings?.defaultProvider ?? initial.providers[0]?.id ?? "")); setModel(String(initial.settings?.defaultModel ?? "")); setLoading(false); }, [profile, initial]);
  useEffect(() => { if (!models.some((item) => item.id === model)) setModel(models[0]?.id ?? ""); }, [models, model]);
  const save = async () => { if (!provider || !model || saving) return; try { setSaving(true); const response = await fetch(`/api/pi/profiles/${encodeURIComponent(profile)}/model`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, model }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Unable to save model"); toast("Model saved. New sessions will use this selection."); } catch (error) { toast((error as Error).message, "error"); } finally { setSaving(false); } };
  return <Card><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle>Model</CardTitle><p className="text-sm text-zinc-500">Choose the default provider and model for this profile.</p></div><Button className="!bg-[#2bbb77] hover:!bg-[#249b63]" title="Save model" disabled={loading || saving || !provider || !model} onClick={save}>{saving ? <Loader2 className="animate-spin" size={17}/> : <Save size={17}/>}</Button></div>{loading ? <div className="flex min-h-40 items-center justify-center gap-3 text-sm text-zinc-500"><Loader2 className="animate-spin" size={18}/>Loading models…</div> : <div className="mt-5 grid gap-4 md:grid-cols-2"><label className="grid gap-1.5 text-sm font-medium text-zinc-700">Provider<select className="rounded-md border border-zinc-200 px-3 py-2 font-normal" value={provider} onChange={(event) => setProvider(event.target.value)} disabled={catalog.providers.length === 0}>{catalog.providers.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><label className="grid gap-1.5 text-sm font-medium text-zinc-700">Model<select className="rounded-md border border-zinc-200 px-3 py-2 font-normal" value={model} onChange={(event) => setModel(event.target.value)} disabled={models.length === 0}>{models.map((item) => <option key={item.id} value={item.id}>{item.name === item.id ? item.id : `${item.name} (${item.id})`}</option>)}</select></label>{catalog.providers.length === 0 && <p className="text-sm text-zinc-500 md:col-span-2">No models are available for this profile.</p>}</div>}</Card>;
}

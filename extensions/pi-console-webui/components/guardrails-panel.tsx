"use client";

import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { Check, ChevronDown, Eye, FileCode2, Loader2, MessageSquare, Plus, RotateCw, Save, ShieldCheck, Sparkles, Trash2, Wrench, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/toast";

type Stage = "input" | "pre_tool" | "post_tool" | "output";
type Mode = "transform" | "evaluate" | "reflect";
type Guardrail = { name: string; stage: Stage; mode: Mode; order: number; file: string; enabled?: boolean };
type Form = { name: string; stage: Stage; mode: Mode; order: string; prompt: string };
type Option<T extends string> = { value: T; label: string; description: string; icon: typeof MessageSquare };

const stages: Option<Stage>[] = [
  { value: "input", label: "On Input", description: "Before the agent processes a user message.", icon: MessageSquare },
  { value: "pre_tool", label: "Before Tool Execution", description: "Before a tool call is allowed to run.", icon: Wrench },
  { value: "post_tool", label: "After Tool Execution", description: "After a tool returns its result.", icon: FileCode2 },
  { value: "output", label: "On Output", description: "Handle the assistant response before delivery.", icon: Eye },
];
const modes: Option<Mode>[] = [
  { value: "transform", label: "Transform", description: "Rewrite content using the Markdown instructions.", icon: Sparkles },
  { value: "evaluate", label: "Evaluate", description: "Allow or block content with a safe user response.", icon: ShieldCheck },
  { value: "reflect", label: "Reflect", description: "Review a candidate response before finalizing it.", icon: Eye },
];
const emptyForm = (): Form => ({ name: "", stage: "input", mode: "evaluate", order: "10", prompt: "" });

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`/api/pi/${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error?.message ?? body.error ?? "Request failed");
  }
  return response;
}

function OptionSelect<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Option<T>[]; onChange: (value: T) => void }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const Icon = selected.icon;
  return <label className="relative grid gap-1.5 text-sm font-semibold text-zinc-800"><span>{label}</span><button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-left font-normal shadow-sm hover:border-zinc-300" onClick={() => setOpen((current) => !current)}><Icon className="shrink-0 text-violet-600" size={17}/><span className="min-w-0 flex-1 truncate">{selected.label}</span><ChevronDown className="shrink-0 text-zinc-400" size={16}/></button>{open && <div className="absolute top-[4.65rem] z-20 w-full overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 shadow-xl">{options.map((option) => { const ItemIcon = option.icon; return <button key={option.value} type="button" className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-zinc-50" onClick={() => { onChange(option.value); setOpen(false); }}><ItemIcon className="mt-0.5 shrink-0 text-violet-600" size={17}/><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-zinc-800">{option.label}</span><span className="mt-0.5 block text-xs font-normal leading-4 text-zinc-500">{option.description}</span></span>{option.value === value && <Check className="mt-0.5 shrink-0 text-emerald-600" size={16}/>}</button>; })}</div>}</label>;
}

export function GuardrailsPanel({ profile, initial }: { profile: string; initial?: { content: string } }) {
  const { toast } = useToast();
  const [items, setItems] = useState<Guardrail[]>([]);
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<"create" | "edit">();
  const [editing, setEditing] = useState<Guardrail>();
  const [form, setForm] = useState<Form>(emptyForm());
  const [saving, setSaving] = useState(false);
  const parse = (content: string) => { const value = JSON.parse(content) as { guardrails?: Guardrail[] }; if (!Array.isArray(value.guardrails)) throw new Error("guardrails.json must contain a guardrails array."); return value.guardrails; };
  const load = async () => { try { const response = await request(`profiles/${profile}/guardrails`); const data = await response.json() as { content: string }; setItems(parse(data.content)); setNotice(""); } catch (error) { setNotice((error as Error).message); } };
  const saveConfig = async (next: Guardrail[]) => { await request(`profiles/${profile}/guardrails`, { method: "PUT", body: JSON.stringify({ content: `${JSON.stringify({ guardrails: next }, null, 2)}\n` }) }); setItems(next); };
  const openCreate = () => { setForm(emptyForm()); setEditing(undefined); setDialog("create"); };
  const openEdit = async (guardrail: Guardrail) => { try { const response = await request(`profiles/${profile}/guardrails/${encodeURIComponent(guardrail.file)}/document`); const data = await response.json() as { content: string }; setEditing(guardrail); setForm({ name: guardrail.name, stage: guardrail.stage, mode: guardrail.mode, order: String(guardrail.order), prompt: data.content }); setDialog("edit"); } catch (error) { setNotice((error as Error).message); } };
  const close = () => { setDialog(undefined); setEditing(undefined); };
  const valid = /^[a-z][a-z0-9-]{0,63}$/.test(form.name) && Number.isInteger(Number(form.order));
  const saveDialog = async () => {
    if (!valid || saving) return;
    const file = editing?.file ?? `${form.name}.md`;
    if (!editing && items.some((item) => item.name === form.name)) { setNotice("A guardrail with this name already exists."); return; }
    try {
      setSaving(true);
      await request(`profiles/${profile}/guardrails/${encodeURIComponent(file)}/document`, { method: "PUT", body: JSON.stringify({ content: form.prompt }) });
      const nextGuardrail: Guardrail = { name: form.name, stage: form.stage, mode: form.mode, order: Number(form.order), file, enabled: editing?.enabled ?? true };
      await saveConfig(editing ? items.map((item) => item.name === editing.name ? nextGuardrail : item) : [...items, nextGuardrail]);
      toast(editing ? "Guardrail saved." : "Guardrail created and enabled.");
      close();
    } catch (error) { setNotice((error as Error).message); } finally { setSaving(false); }
  };
  useEffect(() => { if (initial) { try { setItems(parse(initial.content)); } catch (error) { setNotice((error as Error).message); } return; } void load(); }, [profile, initial]);
  return <><Card><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle>Guardrails</CardTitle><p className="mt-1 text-sm text-zinc-500">Rules are enabled per profile. Markdown prompts are global and may be shared.</p></div><div className="flex gap-2"><Button className="bg-zinc-100 text-zinc-700 hover:bg-zinc-200" title="Reload guardrails" onClick={() => void load()}><RotateCw size={17}/></Button><Button title="Add guardrail" onClick={openCreate}><Plus size={17}/></Button></div></div>{notice && <p className="mt-3 text-sm text-red-700">{notice}</p>}<div className="mt-5 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-zinc-200 text-zinc-500"><tr><th className="p-3">Name</th><th className="p-3">Stage</th><th className="p-3">Mode</th><th className="p-3">Order</th><th className="p-3">Enabled</th><th className="p-3"/></tr></thead><tbody>{[...items].sort((a, b) => a.stage.localeCompare(b.stage) || a.order - b.order || a.name.localeCompare(b.name)).map((guardrail) => <tr key={guardrail.name} className="border-b border-zinc-100"><td className="p-3"><p className="font-medium">{guardrail.name}</p><p className="text-xs text-zinc-400">{guardrail.file}</p></td><td className="p-3">{stages.find((option) => option.value === guardrail.stage)?.label}</td><td className="p-3">{modes.find((option) => option.value === guardrail.mode)?.label}</td><td className="p-3">{guardrail.order}</td><td className="p-3"><Switch checked={guardrail.enabled !== false} onCheckedChange={async (enabled) => { try { await saveConfig(items.map((item) => item.name === guardrail.name ? { ...item, enabled } : item)); toast(`Guardrail ${enabled ? "enabled" : "disabled"}.`); } catch (error) { setNotice((error as Error).message); } }}/></td><td className="whitespace-nowrap p-3"><button className="rounded p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900" title={`Edit ${guardrail.name}`} onClick={() => void openEdit(guardrail)}><FileCode2 size={17}/></button><button className="rounded p-2 text-zinc-400 hover:bg-red-50 hover:text-red-600" title={`Delete ${guardrail.name}`} onClick={async () => { if (!confirm(`Delete guardrail '${guardrail.name}' from profile '${profile}'? Its global prompt file will be kept for other profiles.`)) return; try { await saveConfig(items.filter((item) => item.name !== guardrail.name)); toast("Guardrail deleted from this profile."); } catch (error) { setNotice((error as Error).message); } }}><Trash2 size={17}/></button></td></tr>)}{items.length === 0 && <tr><td className="p-5 text-zinc-500" colSpan={6}>No guardrails configured for this profile.</td></tr>}</tbody></table></div></Card>{dialog && <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="dialog" aria-modal="true"><div className="max-h-[94vh] w-full max-w-6xl overflow-y-auto rounded-xl bg-white p-6 shadow-2xl"><header className="mb-6 flex items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">{dialog === "create" ? "Create guardrail" : `Edit ${editing?.name}`}</h2><p className="mt-1 text-sm text-zinc-500">{dialog === "create" ? "Configure the profile rule and its global Markdown instructions." : "Changes to the Markdown prompt affect every profile that uses this file."}</p></div><div className="flex gap-2"><Button className="!bg-[#2bbb77] hover:!bg-[#249b63]" title={dialog === "create" ? "Create guardrail" : "Save all guardrail changes"} disabled={!valid} onClick={() => void saveDialog()}>{<Check size={17}/>}</Button><Button className="bg-zinc-100 text-zinc-700 hover:bg-zinc-200" title="Close" onClick={close}><X size={17}/></Button></div></header><div className="grid gap-8 lg:grid-cols-[320px_minmax(0,1fr)]"><section className="grid content-start gap-5"><label className="grid gap-1.5 text-sm font-semibold text-zinc-800"><span>Name</span><Input disabled={dialog === "edit"} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. safe-output"/><span className="text-xs font-normal text-zinc-500">{dialog === "create" ? <>Uses lowercase letters, numbers and hyphens. File: <code>{form.name || "name"}.md</code>.</> : <>Names cannot change after creation. File: <code>{editing?.file}</code>.</>}</span></label><OptionSelect label="Stage" value={form.stage} options={stages} onChange={(stage) => setForm({ ...form, stage })}/><OptionSelect label="Mode" value={form.mode} options={modes} onChange={(mode) => setForm({ ...form, mode })}/><label className="grid gap-1.5 text-sm font-semibold text-zinc-800"><span>Order</span><Input type="number" min="0" value={form.order} onChange={(event) => setForm({ ...form, order: event.target.value })}/><span className="text-xs font-normal text-zinc-500">Lower values run first within the same stage.</span></label></section><section className="min-w-0"><label className="mb-2 block text-sm font-semibold text-zinc-800">Markdown instructions</label><p className="mb-3 text-xs text-zinc-500">Syntax-highlighted Markdown editor. This is instruction text only; preview and rich editing are intentionally disabled.</p><div className="overflow-hidden rounded-lg border border-zinc-200"><CodeMirror value={form.prompt} height="580px" extensions={[markdown()]} onChange={(prompt) => setForm({ ...form, prompt })}/></div></section></div></div></div>}</>;
}

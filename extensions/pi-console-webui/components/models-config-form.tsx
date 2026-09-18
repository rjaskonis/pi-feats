"use client";

import { useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json as jsonLanguage } from "@codemirror/lang-json";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/toast";

export function ModelsConfigForm({ initial }: { initial?: string }) {
  const { toast } = useToast();
  const [content, setContent] = useState(initial ?? "{\n  \"providers\": {}\n}\n");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (saving) return;
    try {
      setSaving(true);
      const response = await fetch("/api/admin/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to save models.json");
      setContent(body.content);
      toast("models.json saved. Open /model again to load the updated catalog.");
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };
  return <Card><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle>Models</CardTitle><p className="text-sm text-zinc-500">Shared <code>models.json</code> catalog for every profile. Provider credentials may be present.</p></div><Button className="!bg-[#2bbb77] hover:!bg-[#249b63]" title="Save models.json" disabled={saving} onClick={save}>{saving ? <Loader2 className="animate-spin" size={17}/> : <Save size={17}/>}</Button></div><div className="mt-4"><label id="models-json-label" className="mb-1.5 block text-sm font-medium text-zinc-700">models.json</label><div aria-labelledby="models-json-label" className="overflow-hidden rounded-lg border border-zinc-200"><CodeMirror value={content} height="520px" extensions={[jsonLanguage()]} onChange={setContent} aria-label="models.json editor"/></div></div></Card>;
}

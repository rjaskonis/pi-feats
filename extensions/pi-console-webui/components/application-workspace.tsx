"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, ArrowLeft, FileCode2, Settings2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApplicationHandlerEditor } from "@/components/application-handler-editor";
import { ApplicationLogs } from "@/components/application-logs";
import { ApplicationSettings } from "@/components/application-settings";
import { ApplicationMappings } from "@/components/application-mappings";
const tab = (value: string | null): "settings" | "handlers" | "mappings" | "logs" => value === "handlers" || value === "mappings" || value === "logs" ? value : "settings";
export function ApplicationWorkspace({ slug }: { slug: string }) {
  const router = useRouter(), params = useSearchParams(), selected = tab(params.get("tab")), isNew = slug === "new";
  return <div className="space-y-5"><header className="flex items-center gap-3"><Link href="/applications?context=admin" className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100"><ArrowLeft size={18}/></Link><div><h2 className="text-xl font-semibold">{isNew ? "Create Application" : `Application: ${slug}`}</h2><p className="text-sm text-zinc-500">{isNew ? "Configure a new public Pi endpoint." : "Manage endpoint settings, handlers and execution logs."}</p></div></header>{isNew ? <ApplicationSettings slug="new"/> : <Tabs value={selected} onValueChange={(value) => router.replace(`/applications/${encodeURIComponent(slug)}?context=admin&tab=${tab(value)}`)}><TabsList><TabsTrigger value="settings"><Settings2 className="mr-2 text-sky-600" size={16}/>Settings</TabsTrigger><TabsTrigger value="handlers"><FileCode2 className="mr-2 text-violet-600" size={16}/>Handlers</TabsTrigger><TabsTrigger value="mappings"><Settings2 className="mr-2 text-amber-600" size={16}/>Identity mappings</TabsTrigger><TabsTrigger value="logs"><Activity className="mr-2 text-emerald-600" size={16}/>Logs</TabsTrigger></TabsList><TabsContent value="settings"><ApplicationSettings slug={slug}/></TabsContent><TabsContent value="handlers"><ApplicationHandlerEditor name={slug} embedded/></TabsContent><TabsContent value="mappings"><ApplicationMappings slug={slug}/></TabsContent><TabsContent value="logs"><ApplicationLogs name={slug} embedded/></TabsContent></Tabs>}</div>;
}

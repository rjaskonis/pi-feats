import { notFound } from "next/navigation";
import { ConsolePage } from "@/components/console-page";
const sections = new Set(["chat", "profiles", "settings", "env", "soul", "guardrails", "skills", "tools", "packages", "pulses", "extensions", "applications", "api-server", "pi-console-webui", "skill-sources"]);
export default async function SectionPage({ params, searchParams }: { params: Promise<{ section: string }>; searchParams: Promise<{ profile?: string }> }) { const { section } = await params; if (!sections.has(section)) notFound(); return <ConsolePage section={section} profile={(await searchParams).profile}/>; }

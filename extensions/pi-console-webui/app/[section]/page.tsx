import { notFound } from "next/navigation";
import { ConsolePage } from "@/components/console-page";
import { sectionMetadata } from "@/lib/page-metadata";
const sections = new Set(["chat", "profiles", "settings", "model", "env", "soul", "context-memory", "guardrails", "skills", "tools", "packages", "pulses", "sequential-workflows", "extensions", "applications", "models", "api-server", "pi-console-webui", "skill-sources"]);
export async function generateMetadata({ params, searchParams }: { params: Promise<{ section: string }>; searchParams: Promise<{ profile?: string }> }) {
  return sectionMetadata((await params).section, (await searchParams).profile);
}

export default async function SectionPage({ params, searchParams }: { params: Promise<{ section: string }>; searchParams: Promise<{ profile?: string }> }) { const { section } = await params; if (!sections.has(section)) notFound(); return <ConsolePage section={section} profile={(await searchParams).profile}/>; }

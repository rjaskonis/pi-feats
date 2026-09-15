import { ConsolePage } from "@/components/console-page";
import { sectionMetadata } from "@/lib/page-metadata";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ profile?: string }> }) {
  return sectionMetadata("overview", (await searchParams).profile);
}

export default async function Page({ searchParams }: { searchParams: Promise<{ profile?: string }> }) { return <ConsolePage section="overview" profile={(await searchParams).profile}/>; }

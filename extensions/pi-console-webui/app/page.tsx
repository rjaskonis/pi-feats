import { ConsolePage } from "@/components/console-page";
export default async function Page({ searchParams }: { searchParams: Promise<{ profile?: string }> }) { return <ConsolePage section="overview" profile={(await searchParams).profile}/>; }

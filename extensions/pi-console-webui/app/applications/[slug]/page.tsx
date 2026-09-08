import { ConsolePage } from "@/components/console-page";
export default async function ApplicationPage({ params }: { params: Promise<{ slug: string }> }) { return <ConsolePage section="applications" applicationSlug={(await params).slug}/>; }

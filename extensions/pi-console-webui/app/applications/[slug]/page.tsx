import { ConsolePage } from "@/components/console-page";
import { pageMetadata } from "@/lib/page-metadata";
import { piGet } from "@/lib/pi-api";

type ApplicationResponse = { application: { name?: string } };

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const { application } = await piGet<ApplicationResponse>(`applications/${encodeURIComponent(slug)}`);
    return pageMetadata(application.name?.trim() || `Application: ${slug}`);
  } catch {
    return pageMetadata(`Application: ${slug}`);
  }
}

export default async function ApplicationPage({ params }: { params: Promise<{ slug: string }> }) { return <ConsolePage section="applications" applicationSlug={(await params).slug}/>; }

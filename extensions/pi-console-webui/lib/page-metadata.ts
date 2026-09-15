import type { Metadata } from "next";

const sectionLabels: Record<string, string> = {
  overview: "Overview",
  chat: "Chat",
  profiles: "Profiles",
  settings: "Settings",
  env: "Environment",
  soul: "SOUL",
  "context-memory": "Context Memory",
  guardrails: "Guardrails",
  skills: "Skills",
  tools: "Tools",
  packages: "Packages",
  pulses: "Pulses",
  extensions: "Extensions",
  applications: "Applications",
  "api-server": "API Server",
  "pi-console-webui": "Console WebUI",
  "skill-sources": "Skill Sources",
};

const administrativeSections = new Set(["applications", "api-server", "pi-console-webui", "skill-sources"]);

export function sectionMetadata(section: string, profile?: string): Metadata {
  const label = sectionLabels[section] ?? "Pi Console";
  const selectedProfile = profile?.trim() || "default";
  return { title: administrativeSections.has(section) ? label : `${label} — ${selectedProfile}` };
}

export function pageMetadata(title: string): Metadata {
  return { title };
}

export type ConversationEntry = { role: "user" | "assistant"; text: string; timestamp?: number };
export type ConversationCandidate = { id: string; name?: string | null; updatedAt: Date; entries: ConversationEntry[] };
export type ConversationSearchResult = { id: string; name?: string | null; updatedAt: Date; score: number; excerpts: ConversationEntry[] };

const normalized = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
const clip = (value: string, limit = 700) => value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

export function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("\n");
}

export function searchConversationEntries(query: string, candidates: ConversationCandidate[], limit = 5): ConversationSearchResult[] {
  const needle = normalized(query).trim();
  const terms = [...new Set(needle.split(/\s+/).filter((term) => term.length > 1))];
  if (!needle || !terms.length) return [];
  return candidates.map((candidate) => {
    const id = normalized(candidate.id), name = normalized(candidate.name ?? "");
    const exactId = id === needle, idMatch = !exactId && id.includes(needle), nameMatch = name.includes(needle);
    const matches = candidate.entries.map((entry) => {
      const haystack = normalized(entry.text);
      const termMatches = terms.filter((term) => haystack.includes(term)).length;
      return { entry, termMatches, phrase: haystack.includes(needle) };
    }).filter((match) => match.termMatches > 0);
    if (!exactId && !idMatch && !nameMatch && !matches.length) return undefined;
    const score = (exactId ? 10_000 : idMatch ? 5_000 : nameMatch ? 1_000 : 0) + matches.reduce((total, match) => total + match.termMatches + (match.phrase ? terms.length * 2 : 0), 0);
    const excerpts = matches.length
      ? matches.sort((left, right) => (right.phrase ? 1 : 0) - (left.phrase ? 1 : 0) || right.termMatches - left.termMatches).slice(0, 2).map(({ entry }) => ({ ...entry, text: clip(entry.text) }))
      : candidate.entries.slice(-2).map((entry) => ({ ...entry, text: clip(entry.text) }));
    return { id: candidate.id, name: candidate.name, updatedAt: candidate.updatedAt, score, excerpts };
  }).filter((result): result is ConversationSearchResult => Boolean(result)).sort((left, right) => right.score - left.score || right.updatedAt.getTime() - left.updatedAt.getTime()).slice(0, Math.max(1, Math.min(10, limit)));
}

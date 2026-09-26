import { basename, extname, join } from "node:path";

export type PackageManifest = {
  pi?: { extensions?: unknown; skills?: unknown };
};

export type InstalledPackage = {
  base: string;
  name: string;
  manifest?: PackageManifest;
};

export type PackageExtension = {
  name: string;
  aliases: string[];
  path: string;
  packageName: string;
};

const extensionFileName = (entry: string) => basename(entry, extname(entry));

/**
 * Derive stable user-facing names for package extensions.
 *
 * A package whose only extension is an index entry uses the package name so
 * users do not have to address a generic "index" extension. The technical
 * entry name remains an alias for backwards compatibility.
 */
export function packageExtensions(packages: InstalledPackage[]): PackageExtension[] {
  const candidates: Array<PackageExtension & { preferredName: string }> = [];
  for (const pkg of packages) {
    const entries = Array.isArray(pkg.manifest?.pi?.extensions)
      ? pkg.manifest.pi.extensions.filter((entry): entry is string => typeof entry === "string")
      : [];
    const soleIndexEntry = entries.length === 1 && extensionFileName(entries[0]) === "index";
    for (const entry of entries) {
      const technicalName = extensionFileName(entry);
      const preferredName = soleIndexEntry ? pkg.name : technicalName;
      candidates.push({
        name: preferredName,
        preferredName,
        aliases: [...new Set([preferredName, technicalName])],
        path: join(pkg.base, entry),
        packageName: pkg.name,
      });
    }
  }

  const preferredNameCounts = new Map<string, number>();
  for (const candidate of candidates) {
    preferredNameCounts.set(candidate.preferredName, (preferredNameCounts.get(candidate.preferredName) ?? 0) + 1);
  }
  return candidates.map(({ preferredName, ...candidate }) => {
    const technicalName = extensionFileName(candidate.path);
    const name = (preferredNameCounts.get(preferredName) ?? 0) === 1 ? preferredName : technicalName;
    return { ...candidate, name, aliases: [...new Set([name, ...candidate.aliases])] };
  });
}

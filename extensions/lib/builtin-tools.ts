export const BUILTIN_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;

// Pi 0.87 enables these four built-ins when settings.defaultTools is absent.
export const DEFAULT_ACTIVE_BUILTIN_TOOLS = ["read", "bash", "edit", "write"] as const;

type ToolSettings = Record<string, unknown>;

export function activeBuiltinTools(settings: ToolSettings): string[] {
  const configured = settings.defaultTools;
  return Array.isArray(configured)
    ? configured.filter((tool): tool is string => typeof tool === "string")
    : [...DEFAULT_ACTIVE_BUILTIN_TOOLS];
}

export function updatedBuiltinTools(settings: ToolSettings, name: string, enabled: boolean): string[] | undefined {
  const current = activeBuiltinTools(settings);
  const updated = enabled
    ? [...new Set([...current, name])]
    : current.filter((tool) => tool !== name);
  return updated.length === DEFAULT_ACTIVE_BUILTIN_TOOLS.length
    && DEFAULT_ACTIVE_BUILTIN_TOOLS.every((tool) => updated.includes(tool))
    ? undefined
    : updated;
}

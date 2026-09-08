"use client";
import { createContext, useCallback, useContext, useRef, useState } from "react";

type Profile = { name: string; path: string };
type ConsoleState = { profiles: Profile[]; health: string; error: string; initialize: () => Promise<void>; refreshProfiles: () => Promise<Profile[]> };
const StateContext = createContext<ConsoleState | undefined>(undefined);

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`/api/pi/${path}`);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message ?? body.error ?? "Request failed"); }
  return response.json() as Promise<T>;
}

export function ConsoleStateProvider({ children }: { children: React.ReactNode }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [health, setHealth] = useState("Checking…");
  const [error, setError] = useState("");
  const initialized = useRef(false);
  const refreshProfiles = useCallback(async () => { const data = await getJson<{ profiles: Profile[] }>("profiles"); setProfiles(data.profiles); return data.profiles; }, []);
  const initialize = useCallback(async () => {
    if (initialized.current) return;
    initialized.current = true;
    try {
      const [healthData, profileData] = await Promise.all([getJson<{ status: string }>("health"), getJson<{ profiles: Profile[] }>("profiles")]);
      setHealth(healthData.status); setProfiles(profileData.profiles);
    } catch (cause) { setHealth("Unavailable"); setError((cause as Error).message); }
  }, []);
  return <StateContext.Provider value={{ profiles, health, error, initialize, refreshProfiles }}>{children}</StateContext.Provider>;
}
export function useConsoleState() { const state = useContext(StateContext); if (!state) throw new Error("useConsoleState must be used inside ConsoleStateProvider"); return state; }

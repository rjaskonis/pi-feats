"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
export default function Login() {
  const router = useRouter(); const [username, setUsername] = useState(""), [password, setPassword] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  async function submit(event: React.FormEvent) { event.preventDefault(); if (loading) return; setError(""); setLoading(true); try { const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) }); if (response.ok) router.push("/"); else { setError("Invalid credentials."); window.setTimeout(() => setError(""), 4_000); } } catch { setError("Unable to sign in."); window.setTimeout(() => setError(""), 4_000); } finally { setLoading(false); } }
  return <main className="grid min-h-screen place-items-center p-4"><form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-xl"><h1 className="text-2xl font-bold">Pi Console</h1><p className="text-sm text-zinc-400">Sign in to manage Pi.</p><Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" autoFocus /><Input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" />{error && <p className="text-sm text-red-400">{error}</p>}<Button className="w-full" disabled={loading}>{loading ? <><Loader2 className="mr-2 animate-spin" size={16}/>Signing in…</> : "Sign in"}</Button></form></main>;
}

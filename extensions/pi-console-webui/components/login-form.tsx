"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { useToast } from "@/components/toast";

export function LoginForm() {
  const router = useRouter(); const { toast } = useToast(); const [username, setUsername] = useState(""), [password, setPassword] = useState(""), [loading, setLoading] = useState(false);
  async function submit(event: React.FormEvent) { event.preventDefault(); if (loading) return; setLoading(true); try { const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) }); if (response.ok) router.push("/"); else toast("Invalid credentials.", "error"); } catch { toast("Unable to sign in.", "error"); } finally { setLoading(false); } }
  return <main className="grid min-h-screen place-items-center p-4"><form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-xl border border-zinc-200 bg-white p-6 shadow-xl"><div className="space-y-1"><h1 className="text-2xl font-bold text-zinc-900">Pi Console</h1><p className="text-sm text-zinc-600">Sign in to manage Pi.</p></div><label className="grid gap-1.5 text-sm font-medium text-zinc-700"><span>Username</span><Input className="border-zinc-300 bg-white text-zinc-900 placeholder:text-zinc-400 focus:border-[#00b9ed]" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus /></label><label className="grid gap-1.5 text-sm font-medium text-zinc-700"><span>Password</span><Input className="border-zinc-300 bg-white text-zinc-900 placeholder:text-zinc-400 focus:border-[#00b9ed]" value={password} onChange={(e) => setPassword(e.target.value)} type="password" /></label><Button className="w-full" disabled={loading}>{loading ? <><Loader2 className="mr-2 animate-spin" size={16}/>Signing in…</> : "Sign in"}</Button></form></main>;
}

import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { authenticated } from "@/lib/auth";
const commands = { "api-server": ["api", "restart"], "pi-console-webui": ["console", "restart"] } as const;
export async function POST(_: Request, { params }: { params: Promise<{ service: string }> }) { if (!(await authenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); const { service } = await params; if (!(service in commands)) return NextResponse.json({ error: "Not found" }, { status: 404 }); const child = spawn("pi", commands[service as keyof typeof commands], { detached: true, stdio: "ignore", env: process.env }); child.unref(); return NextResponse.json({ ok: true }, { status: 202 }); }

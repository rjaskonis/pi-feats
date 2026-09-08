import { NextResponse } from "next/server";
import { authToken, COOKIE, loginValid } from "@/lib/auth";
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (typeof body.username !== "string" || typeof body.password !== "string" || !(await loginValid(body.username, body.password))) return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE, await authToken(), { httpOnly: true, sameSite: "strict", secure: process.env.PI_CONSOLE_HTTPS === "1", path: "/", maxAge: 60 * 60 * 12 });
  return response;
}

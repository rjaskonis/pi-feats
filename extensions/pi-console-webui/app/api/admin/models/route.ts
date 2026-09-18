import { NextResponse } from "next/server";
import { authenticated } from "@/lib/auth";
import { readModelsConfig, writeModelsConfig } from "@/lib/admin-models";

export async function GET() {
  if (!(await authenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ content: await readModelsConfig() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to read models.json" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  if (!(await authenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { content } = await request.json();
    return NextResponse.json({ content: await writeModelsConfig(content) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid models.json" }, { status: 400 });
  }
}

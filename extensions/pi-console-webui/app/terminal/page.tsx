import { redirect } from "next/navigation";
import { authenticated } from "@/lib/auth";
import { TerminalClient } from "@/components/terminal-client";

export const metadata = { title: "Terminal" };

export default async function TerminalPage() { if (!(await authenticated())) redirect("/login"); return <TerminalClient/>; }

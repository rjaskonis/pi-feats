import "./globals.css";
import { ToastProvider } from "@/components/toast";
import { ConsoleStateProvider } from "@/components/console-state";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: { default: "π Console", template: "%s | π Console" },
  description: "Pi API console",
};
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="pt-BR"><body><ToastProvider><ConsoleStateProvider>{children}</ConsoleStateProvider></ToastProvider></body></html>; }

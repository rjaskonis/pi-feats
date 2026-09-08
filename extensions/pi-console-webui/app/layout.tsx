import "./globals.css";
import { ToastProvider } from "@/components/toast";
import { ConsoleStateProvider } from "@/components/console-state";
export const metadata = { title: "Pi Console", description: "Pi API console" };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="pt-BR"><body><ToastProvider><ConsoleStateProvider>{children}</ConsoleStateProvider></ToastProvider></body></html>; }

"use client";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function TerminalClient() {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Connecting…");
  useEffect(() => {
    if (!host.current) return;
    const terminal = new Terminal({ cursorBlink: true, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 14, theme: { background: "#09090b", foreground: "#e4e4e7" } });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    fit.fit();
    let socket: WebSocket | undefined;
    let disposed = false;
    const resize = () => { fit.fit(); if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows })); };
    window.addEventListener("resize", resize);
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const input = terminal.onData((data) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data })); });
    void fetch("/api/pi/terminal/ticket", { method: "POST" }).then(async (response) => {
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error?.message ?? "Unable to start terminal.");
      return response.json() as Promise<{ url: string; cwd: string }>;
    }).then(({ url, cwd }) => {
      if (disposed) return;
      terminal.writeln(`\x1b[90mPi system terminal · ${cwd}\x1b[0m\r\n`);
      socket = new WebSocket(url);
      socket.onopen = () => { setStatus("Connected"); resize(); terminal.focus(); };
      socket.onmessage = (event) => { const message = JSON.parse(event.data) as { type: string; data: string }; if (message.type === "output") terminal.write(message.data, () => terminal.scrollToBottom()); if (message.type === "error") { terminal.writeln(`\r\n\x1b[31m${message.data}\x1b[0m`); setStatus("Error"); } };
      socket.onclose = () => { if (!disposed) setStatus("Disconnected"); };
      socket.onerror = () => setStatus("Connection error");
    }).catch((error) => { terminal.writeln(`\x1b[31m${error.message}\x1b[0m`); setStatus("Error"); });
    return () => { disposed = true; observer.disconnect(); window.removeEventListener("resize", resize); input.dispose(); socket?.close(); terminal.dispose(); };
  }, []);
  return <main className="terminal-page flex h-screen flex-col"><header className="terminal-header flex items-center justify-between px-5 py-3 text-sm"><span>Pi System Terminal</span><span>{status}</span></header><div className="terminal-screen min-h-0 flex-1"><div ref={host} className="terminal-host"/></div></main>;
}

"use client";
import { createContext, useContext, useState } from "react";
import { CheckCircle2, CircleAlert, X } from "lucide-react";

type ToastType = "success" | "error" | "info";
type ToastItem = { id: number; message: string; type: ToastType };
const ToastContext = createContext<{ toast: (message: string, type?: ToastType) => void }>({ toast: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const toast = (message: string, type: ToastType = "success") => {
    const id = Date.now() + Math.random();
    setItems((current) => [...current, { id, message, type }]);
    window.setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), 4500);
  };
  return <ToastContext.Provider value={{ toast }}>{children}<div className="fixed right-5 top-5 z-[100] flex w-full max-w-sm flex-col gap-2" aria-live="polite">{items.map((item) => <div key={item.id} className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg ${item.type === "error" ? "border-red-200 bg-red-50 text-red-800" : item.type === "info" ? "border-blue-200 bg-blue-50 text-blue-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}><span>{item.type === "error" ? <CircleAlert size={18}/> : <CheckCircle2 size={18}/>}</span><p className="flex-1">{item.message}</p><button className="rounded p-1 hover:bg-black/5" title="Dismiss notification" onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}><X size={15}/></button></div>)}</div></ToastContext.Provider>;
}
export const useToast = () => useContext(ToastContext);

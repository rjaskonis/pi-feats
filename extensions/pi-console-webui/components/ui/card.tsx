import { type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <section className={cn("rounded-xl border border-zinc-200 bg-white p-5 shadow-sm", className)} {...props} />; }
export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) { return <h2 className={cn("text-lg font-semibold text-zinc-900", className)} {...props} />; }

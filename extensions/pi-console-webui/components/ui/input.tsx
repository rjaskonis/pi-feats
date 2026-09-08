import { type InputHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => <input ref={ref} className={cn("w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-blue-500", className)} {...props} />);
Input.displayName = "Input";

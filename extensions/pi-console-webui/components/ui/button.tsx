import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(({ className, ...props }, ref) => <button ref={ref} className={cn("rounded-md bg-[#406889] px-3 py-2 text-sm font-medium text-white hover:bg-[#365a78] disabled:opacity-50", className)} {...props} />);
Button.displayName = "Button";

"use client";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { type ComponentPropsWithoutRef, forwardRef } from "react";
import { cn } from "@/lib/utils";
export const Switch = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>>(({ className, ...props }, ref) => <SwitchPrimitive.Root ref={ref} className={cn("h-6 w-11 rounded-full bg-zinc-300 data-[state=checked]:bg-[#406889]", className)} {...props}><SwitchPrimitive.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-5" /></SwitchPrimitive.Root>);
Switch.displayName = "Switch";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "secondary" | "ghost" | "destructive";
type ButtonSize = "default" | "icon";

function buttonClass(variant: ButtonVariant, size: ButtonSize): string {
  if (size === "icon") return "icon-btn";
  const tone =
    variant === "default"
      ? "btn-primary"
      : variant === "ghost"
        ? "btn-ghost"
        : variant === "destructive"
          ? "btn-danger"
          : "";
  return cn("btn", tone);
}

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      {...(!asChild ? { type: "button" as const } : {})}
      data-slot="button"
      className={cn(buttonClass(variant, size), className)}
      {...props}
    />
  );
}

export { Button, buttonClass };

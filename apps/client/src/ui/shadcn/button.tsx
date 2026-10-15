import * as React from "react";

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
  ...props
}: React.ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      type="button"
      data-slot="button"
      className={cn(buttonClass(variant, size), className)}
      {...props}
    />
  );
}

export { Button, buttonClass };

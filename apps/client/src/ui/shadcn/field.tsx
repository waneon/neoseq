import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function FieldGroup({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("field-group", className)} {...props} />;
}

function Field({ className, ...props }: ComponentProps<"div">) {
  return <div role="group" className={cn("field", className)} {...props} />;
}

function FieldLabel({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("field-label", className)} {...props} />;
}

function FieldDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("field-description", className)} {...props} />;
}

function FieldError({ className, ...props }: ComponentProps<"p">) {
  return <p role="alert" className={cn("field-error", className)} {...props} />;
}

export { Field, FieldDescription, FieldError, FieldGroup, FieldLabel };

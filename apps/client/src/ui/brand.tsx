import symbolUrl from "../../../../assets/brand/symbol.svg";
import wordmarkUrl from "../../../../assets/brand/wordmark.svg";
import { cn } from "@/lib/utils";

/** The supplied identity symbol, independent of its lettering. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={cn("brand-symbol", className)}
      style={{ maskImage: `url("${symbolUrl}")` }}
      aria-hidden
    />
  );
}

/** Separate silhouettes preserve the supplied lettering at every scale. */
export function Wordmark({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn("brand-lockup", className)} role="img" aria-label={name}>
      <LogoMark />
      <span className="brand-wordmark" style={{ maskImage: `url("${wordmarkUrl}")` }} aria-hidden />
    </span>
  );
}

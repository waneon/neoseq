import symbol from "../../../../assets/brand/symbol.svg";
import wordmark from "../../../../assets/brand/wordmark.svg";

export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={["brand-symbol", className].filter(Boolean).join(" ")}
      aria-hidden="true"
      style={{ maskImage: `url("${symbol}")` }}
    />
  );
}

export function Wordmark({ name }: { name: string }) {
  return (
    <span className="brand-lockup" role="img" aria-label={name}>
      <LogoMark />
      <span
        className="brand-wordmark"
        aria-hidden="true"
        style={{ maskImage: `url("${wordmark}")` }}
      />
    </span>
  );
}

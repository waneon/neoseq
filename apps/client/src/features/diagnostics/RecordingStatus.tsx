import { useEffect, useState } from "react";
import { Button } from "@/ui/shadcn/button";
import { useI18n } from "../../i18n";
import { useDiagnostics, useDiagnosticsState } from "./context";

export function RecordingStatus() {
  const coordinator = useDiagnostics();
  const state = useDiagnosticsState();
  const { message } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const startedAt = state.active?.started_at;

  useEffect(() => {
    if (state.phase !== "recording") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [state.phase]);

  if (state.phase !== "recording" || !startedAt) return null;
  const elapsed = Math.max(0, now - Date.parse(startedAt));
  return (
    <Button
      variant="ghost"
      size="sm"
      className="diagnostic-recording-status"
      aria-label={message("diagnostics.stopAndReview")}
      onClick={() => void coordinator.stop()}
      data-testid="diagnostics-recording-status"
    >
      <span className="diagnostic-recording-dot" aria-hidden />
      <span>{state.active?.capture_policy.level === "enhanced"
        ? message("diagnostics.enhancedRecording")
        : message("diagnostics.recording")}</span>
      <time>{formatElapsed(elapsed)}</time>
    </Button>
  );
}

function formatElapsed(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

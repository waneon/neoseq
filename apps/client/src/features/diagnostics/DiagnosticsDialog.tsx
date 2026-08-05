import { useEffect, useState } from "react";
import { DownloadIcon, Trash2Icon } from "lucide-react";
import {
  buildDiagnosticArtifact,
  downloadDiagnosticArtifact,
} from "../../diagnostics/artifact";
import { Callout, Dialog } from "../../ui/components";
import { Button } from "@/ui/shadcn/button";
import { useI18n } from "../../i18n";
import { useDiagnostics, useDiagnosticsState } from "./context";

export function DiagnosticsDialog() {
  const coordinator = useDiagnostics();
  const state = useDiagnosticsState();
  const { message, formatBytes, formatNumber } = useI18n();
  const [annotation, setAnnotation] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    if (state.review?.session.recording_id) {
      setAnnotation("");
      setSaveError(false);
    }
  }, [state.review?.session.recording_id]);

  if (state.phase === "consent") {
    return (
      <Dialog title={message("diagnostics.consentTitle")} onClose={() => coordinator.cancelStart()}>
        <p className="dialog-description">{message("diagnostics.consentDescription")}</p>
        <section className="diagnostic-disclosure">
          <h3>{message("diagnostics.capturesTitle")}</h3>
          <p>{message("diagnostics.capturesDescription")}</p>
          <h3>{message("diagnostics.excludesTitle")}</h3>
          <p>{message("diagnostics.excludesDescription")}</p>
        </section>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => coordinator.cancelStart()}>
            {message("common.cancel")}
          </Button>
          <Button data-testid="diagnostics-confirm-start" onClick={() => void coordinator.start()}>
            {message("diagnostics.start")}
          </Button>
        </div>
      </Dialog>
    );
  }

  if (state.phase === "finalizing") {
    return (
      <Dialog
        title={message("diagnostics.finalizingTitle")}
        dismissible={false}
        onClose={() => {}}
      >
        <p className="dialog-description" role="status">
          {message("diagnostics.finalizingDescription")}
        </p>
      </Dialog>
    );
  }

  const review = state.review;
  if (state.phase !== "review" || !state.review_open || !review) return null;
  const duration = review.recovered
    ? Math.max(0, review.records.at(-1)?.monotonic_ms ?? 0)
    : Math.max(
      0,
      Date.parse(review.session.stopped_at ?? review.session.started_at) -
        Date.parse(review.session.started_at),
    );

  const save = async () => {
    setSaving(true);
    setSaveError(false);
    try {
      const artifact = await buildDiagnosticArtifact(review, annotation);
      downloadDiagnosticArtifact(artifact);
      await coordinator.discard();
    } catch {
      setSaveError(true);
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={review.recovered
        ? message("diagnostics.recoveredTitle")
        : message("diagnostics.reviewTitle")}
      size="wide"
      onClose={() => coordinator.hideReview()}
    >
      <p className="dialog-description">{message("diagnostics.reviewDescription")}</p>
      {review.recovered && <Callout>{message("diagnostics.recoveredDescription")}</Callout>}
      {state.storage_warning && (
        <Callout tone="danger">{message("diagnostics.storageWarning")}</Callout>
      )}
      <dl className="diagnostic-summary">
        <div>
          <dt>{message("diagnostics.duration")}</dt>
          <dd>{formatDuration(duration)}</dd>
        </div>
        <div>
          <dt>{message("diagnostics.events")}</dt>
          <dd>{formatNumber(review.records.length)}</dd>
        </div>
        <div>
          <dt>{message("diagnostics.size")}</dt>
          <dd>{formatBytes(review.session.byte_count)}</dd>
        </div>
        <div>
          <dt>{message("diagnostics.dropped")}</dt>
          <dd>{formatNumber(review.session.dropped_count)}</dd>
        </div>
      </dl>
      <div className="diagnostic-content-policy">
        <span className="diagnostic-recording-dot" aria-hidden />
        <p>{message("diagnostics.standardPolicy")}</p>
      </div>
      <label className="diagnostic-note-field">
        <span>{message("diagnostics.annotationLabel")}</span>
        <textarea
          value={annotation}
          maxLength={4_000}
          onChange={(event) => setAnnotation(event.target.value)}
          placeholder={message("diagnostics.annotationPlaceholder")}
        />
        <small>{message("diagnostics.annotationDescription")}</small>
      </label>
      {saveError && (
        <p className="field-error" role="alert">{message("diagnostics.saveError")}</p>
      )}
      <div className="dialog-actions diagnostic-review-actions">
        <Button
          variant="destructive"
          disabled={saving}
          onClick={() => void coordinator.discard()}
        >
          <Trash2Icon data-icon="inline-start" aria-hidden />
          {message("diagnostics.discard")}
        </Button>
        <Button disabled={saving} data-testid="diagnostics-download" onClick={() => void save()}>
          <DownloadIcon data-icon="inline-start" aria-hidden />
          {saving ? message("diagnostics.preparing") : message("diagnostics.download")}
        </Button>
      </div>
    </Dialog>
  );
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

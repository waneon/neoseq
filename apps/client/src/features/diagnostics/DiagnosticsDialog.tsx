import { useEffect, useState } from "react";
import { DownloadIcon, ShieldAlertIcon, Trash2Icon } from "lucide-react";
import {
  buildDiagnosticArtifact,
  downloadDiagnosticArtifact,
} from "../../diagnostics/artifact";
import { Callout, Dialog } from "../../ui/components";
import { Button } from "@/ui/shadcn/button";
import { Checkbox } from "@/ui/shadcn/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/ui/shadcn/toggle-group";
import { useI18n } from "../../i18n";
import {
  DEFAULT_ENHANCED_CAPTURE_POLICY,
  STANDARD_CAPTURE_POLICY,
  type DiagnosticCaptureLevel,
  type EnhancedCaptureScope,
  type SensitiveCategory,
} from "../../diagnostics/types";
import { useDiagnostics, useDiagnosticsState } from "./context";

export function DiagnosticsDialog() {
  const coordinator = useDiagnostics();
  const state = useDiagnosticsState();
  const { message, formatBytes, formatNumber } = useI18n();
  const [annotation, setAnnotation] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [captureLevel, setCaptureLevel] = useState<DiagnosticCaptureLevel>("standard");
  const [scope, setScope] = useState<EnhancedCaptureScope>("active_page");
  const [categories, setCategories] = useState<ReadonlySet<SensitiveCategory>>(
    new Set(DEFAULT_ENHANCED_CAPTURE_POLICY.categories),
  );
  const [includeSensitive, setIncludeSensitive] = useState(true);
  const [confirmSensitive, setConfirmSensitive] = useState(false);

  useEffect(() => {
    if (state.review?.session.recording_id) {
      setAnnotation("");
      setSaveError(false);
      setIncludeSensitive(
        state.review.session.capture_policy.level === "enhanced" &&
        state.review.sensitive_payloads.length > 0,
      );
      setConfirmSensitive(false);
    }
  }, [state.review?.session.recording_id]);

  useEffect(() => {
    if (state.phase !== "consent") return;
    setCaptureLevel("standard");
    setScope("active_page");
    setCategories(new Set(DEFAULT_ENHANCED_CAPTURE_POLICY.categories));
  }, [state.phase]);

  if (state.phase === "consent") {
    return (
      <Dialog
        title={message("diagnostics.consentTitle")}
        size="wide"
        onClose={() => coordinator.cancelStart()}
      >
        <p className="dialog-description">{message("diagnostics.consentDescription")}</p>
        <ToggleGroup
          className="diagnostic-level-picker"
          type="single"
          variant="outline"
          value={captureLevel}
          onValueChange={(value) => {
            if (value === "standard" || value === "enhanced") setCaptureLevel(value);
          }}
          aria-label={message("diagnostics.captureLevel")}
        >
          <ToggleGroupItem value="standard">{message("diagnostics.standard")}</ToggleGroupItem>
          <ToggleGroupItem value="enhanced">{message("diagnostics.enhanced")}</ToggleGroupItem>
        </ToggleGroup>
        {captureLevel === "standard" && (
          <section className="diagnostic-disclosure">
            <h3>{message("diagnostics.capturesTitle")}</h3>
            <p>{message("diagnostics.capturesDescription")}</p>
            <h3>{message("diagnostics.excludesTitle")}</h3>
            <p>{message("diagnostics.excludesDescription")}</p>
          </section>
        )}
        {captureLevel === "enhanced" && (
          <section className="diagnostic-enhanced-options">
            <div className="diagnostic-sensitive-heading">
              <ShieldAlertIcon aria-hidden />
              <div>
                <h3>{message("diagnostics.enhancedTitle")}</h3>
                <p>{message("diagnostics.enhancedDescription")}</p>
              </div>
            </div>
            <fieldset>
              <legend>{message("diagnostics.scope")}</legend>
              <ToggleGroup
                className="diagnostic-scope-picker"
                type="single"
                variant="outline"
                value={scope}
                onValueChange={(value) => {
                  if (isEnhancedScope(value)) setScope(value);
                }}
              >
                <ToggleGroupItem value="active_page">{message("diagnostics.scopeActivePage")}</ToggleGroupItem>
                <ToggleGroupItem value="touched_entities">{message("diagnostics.scopeTouched")}</ToggleGroupItem>
                <ToggleGroupItem value="full_graph">{message("diagnostics.scopeFullGraph")}</ToggleGroupItem>
              </ToggleGroup>
            </fieldset>
            <fieldset className="diagnostic-category-list">
              <legend>{message("diagnostics.categories")}</legend>
              <DiagnosticCheckbox
                checked={categories.has("graph_data")}
                onCheckedChange={(checked) => setCategory(categories, setCategories, "graph_data", checked)}
                label={message("diagnostics.categoryGraphData")}
              />
              <DiagnosticCheckbox
                checked={categories.has("query_text")}
                onCheckedChange={(checked) => setCategory(categories, setCategories, "query_text", checked)}
                label={message("diagnostics.categoryQueryText")}
              />
            </fieldset>
            <p className="diagnostic-never-captured">{message("diagnostics.neverCaptured")}</p>
          </section>
        )}
        <div className="dialog-actions diagnostic-consent-actions">
          <Button variant="secondary" onClick={() => coordinator.cancelStart()}>
            {message("common.cancel")}
          </Button>
          <Button
            data-testid="diagnostics-confirm-start"
            disabled={captureLevel === "enhanced" && categories.size === 0}
            onClick={() => void coordinator.start(
              captureLevel === "standard"
                ? STANDARD_CAPTURE_POLICY
                : { level: "enhanced", scope, categories: [...categories] },
            )}
          >
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

  const save = async (confirmedSensitive = false) => {
    if (includeSensitive && review.session.capture_policy.level === "enhanced" && !confirmedSensitive) {
      setConfirmSensitive(true);
      return;
    }
    setSaving(true);
    setSaveError(false);
    try {
      const artifact = await buildDiagnosticArtifact(review, annotation, { includeSensitive });
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
        <p>{review.session.capture_policy.level === "standard"
          ? message("diagnostics.standardPolicy")
          : message("diagnostics.enhancedPolicy")}</p>
      </div>
      {review.session.capture_policy.level === "enhanced" && (
        <section className="diagnostic-sensitive-review">
          <div>
            <h3>{message("diagnostics.sensitiveInventory")}</h3>
            <p>{message("diagnostics.sensitiveInventoryDescription", {
              count: formatNumber(review.sensitive_payloads.length),
              size: formatBytes(review.session.sensitive_byte_count),
            })}</p>
          </div>
          <DiagnosticCheckbox
            checked={includeSensitive}
            disabled={review.sensitive_payloads.length === 0}
            onCheckedChange={(checked) => {
              setIncludeSensitive(checked);
              setConfirmSensitive(false);
            }}
            label={message("diagnostics.includeSensitive")}
          />
        </section>
      )}
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
      {confirmSensitive && (
        <Callout tone="danger">
          <div className="diagnostic-sensitive-confirm">
            <p>{message("diagnostics.sensitiveConfirm")}</p>
            <div className="actions">
              <Button variant="secondary" onClick={() => setConfirmSensitive(false)}>
                {message("common.cancel")}
              </Button>
              <Button disabled={saving} onClick={() => void save(true)}>
                {message("diagnostics.confirmSensitiveDownload")}
              </Button>
            </div>
          </div>
        </Callout>
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

function DiagnosticCheckbox({
  checked,
  onCheckedChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="diagnostic-checkbox">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <span>{label}</span>
    </label>
  );
}

function setCategory(
  categories: ReadonlySet<SensitiveCategory>,
  update: (value: ReadonlySet<SensitiveCategory>) => void,
  category: SensitiveCategory,
  checked: boolean,
): void {
  const next = new Set(categories);
  if (checked) next.add(category);
  else next.delete(category);
  update(next);
}

function isEnhancedScope(value: string): value is EnhancedCaptureScope {
  return value === "active_page" || value === "touched_entities" || value === "full_graph";
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

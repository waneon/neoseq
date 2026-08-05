import type {
  DiagnosticAttributes,
  DiagnosticOperation,
  DiagnosticOutcome,
  WorkerDiagnosticContext,
  WorkerDiagnosticSpan,
} from "./types";

type WorkerSpanSource = WorkerDiagnosticSpan["source"];

export class WorkerDiagnosticCollector {
  private readonly started = performance.now();
  private readonly operationSpanId = crypto.randomUUID();
  private readonly children: WorkerDiagnosticSpan[] = [];

  constructor(
    private readonly context: WorkerDiagnosticContext,
    private readonly operation: string,
  ) {}

  measure<T>(
    source: WorkerSpanSource,
    name: DiagnosticOperation,
    run: () => T,
    attributes: DiagnosticAttributes = {},
  ): T {
    const started = performance.now();
    try {
      const result = run();
      this.push(source, name, started, "ok", attributes);
      return result;
    } catch (error) {
      this.push(source, name, started, "error", attributes);
      throw error;
    }
  }

  async measureAsync<T>(
    source: WorkerSpanSource,
    name: DiagnosticOperation,
    run: () => Promise<T>,
    attributes: DiagnosticAttributes = {},
  ): Promise<T> {
    const started = performance.now();
    try {
      const result = await run();
      this.push(source, name, started, "ok", attributes);
      return result;
    } catch (error) {
      this.push(source, name, started, "error", attributes);
      throw error;
    }
  }

  finish(outcome: DiagnosticOutcome): WorkerDiagnosticSpan[] {
    return [
      {
        trace_id: this.context.trace_id,
        source: "worker",
        name: "worker.operation",
        span_id: this.operationSpanId,
        parent_span_id: this.context.parent_span_id,
        started_offset_ms: 0,
        duration_ms: rounded(performance.now() - this.started),
        outcome,
        attributes: { operation: this.operation },
      },
      ...this.children,
    ];
  }

  private push(
    source: WorkerSpanSource,
    name: DiagnosticOperation,
    started: number,
    outcome: DiagnosticOutcome,
    attributes: DiagnosticAttributes,
  ): void {
    this.children.push({
      trace_id: this.context.trace_id,
      source,
      name,
      span_id: crypto.randomUUID(),
      parent_span_id: this.operationSpanId,
      started_offset_ms: rounded(started - this.started),
      duration_ms: rounded(performance.now() - started),
      outcome,
      attributes,
    });
  }
}

function rounded(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

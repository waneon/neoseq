import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { MoreHorizontalIcon } from "lucide-react";
import {
  deleteGraph,
  listGraphs,
  processPendingDelete,
  registerGraph,
  renameGraph,
  type GraphSummary,
} from "../../core-port/directory";
import { Callout, Dialog } from "../../ui/components";
import { Wordmark } from "../../ui/brand";
import { useNotify } from "../notify/context";
import { Input } from "@/ui/shadcn/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { configuredTimezone } from "../../entities/journal";
import { useI18n } from "../../i18n";
import { useDiagnostics } from "../diagnostics/context";
import { RecordingStatus } from "../diagnostics/RecordingStatus";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; graphs: GraphSummary[] }
  | { status: "failed"; message: string };

const CREATED = { day: "numeric", month: "short", year: "numeric" } as const;

/**
 * The first screen. It carries no entrance animation on purpose: this container
 * is audited by axe the instant it mounts, and a surface fading in at partial
 * alpha composites its text against the background and fails contrast for every
 * child (DESIGN.md § Motion, rule 3).
 *
 * The empty state *is* the action — one sentence above the create form, not a
 * dashed box holding an instruction that points at a form below it.
 */
export function GraphPicker() {
  const { message, formatInstant } = useI18n();
  const diagnostics = useDiagnostics();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<GraphSummary | null>(null);
  const [deleting, setDeleting] = useState<GraphSummary | null>(null);

  const refresh = useCallback(async () => {
    try {
      await processPendingDelete();
      setState({ status: "ready", graphs: await listGraphs() });
    } catch (error) {
      setState({
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    diagnostics.recordRoute("graph_picker");
  }, [diagnostics]);

  const create = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim() || message("graph.defaultName");
    const graph = registerGraph(name);
    navigate(`/g/${graph.id}`);
  };

  return (
    <main className="picker">
      <div className="picker-recording-status">
        <RecordingStatus />
      </div>
      <div className="picker-inner">
        <p className="picker-wordmark">
          <Wordmark name={message("app.title")} />
        </p>
        <h1>{message("graph.yourGraphs")}</h1>
        <p className="picker-lede">
          {message("graph.lede")}
        </p>
        {state.status === "failed" && (
          <Callout tone="danger">
            {message("graph.listFailed", { detail: message("error.internal") })}
          </Callout>
        )}
        {state.status === "ready" && state.graphs.length === 0 && (
          <p className="picker-empty" data-testid="picker-empty">
            {message("graph.empty")}
          </p>
        )}
        {state.status === "ready" && state.graphs.length > 0 && (
          <ul className="graph-list" data-testid="graph-list">
            {state.graphs.map((graph) => (
              <li key={graph.id} className="graph-card">
                <button
                  className="graph-card-open"
                  onClick={() => navigate(`/g/${graph.id}`)}
                  data-testid={`open-graph-${graph.name}`}
                >
                  <span className="name">{graph.name}</span>
                  <span className="meta">
                    {message("graph.created", {
                      date: formatInstant(graph.created_at, configuredTimezone(), CREATED),
                    })}
                  </span>
                </button>
                {/* Both verbs live behind one named menu, so a destructive
                    action is never a pixel away from the open target. The class
                    reveals it on hover and on :focus-within. */}
                <div className="graph-actions">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="icon-btn"
                        aria-label={message("graph.actionsFor", { name: graph.name })}
                      >
                        <MoreHorizontalIcon aria-hidden />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setRenaming(graph)}>
                        {message("graph.rename")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setDeleting(graph)}
                      >
                        {message("graph.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form className="picker-new" onSubmit={create}>
          <Input
            placeholder={message("graph.newName")}
            aria-label={message("graph.newName")}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            data-testid="new-graph-name"
          />
          <button className="btn btn-primary" type="submit" data-testid="create-graph">
            {message("graph.create")}
          </button>
        </form>
      </div>

      {renaming && (
        <RenameDialog
          graph={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={() => {
            setRenaming(null);
            void refresh();
          }}
        />
      )}
      {deleting && (
        <DeleteDialog
          graph={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            void refresh();
          }}
        />
      )}
    </main>
  );
}

function RenameDialog({
  graph,
  onClose,
  onRenamed,
}: {
  graph: GraphSummary;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const { message } = useI18n();
  const [name, setName] = useState(graph.name);
  return (
    <Dialog title={message("graph.rename")} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) {
            renameGraph(graph.id, name);
            onRenamed();
          }
        }}
      >
        <label className="field-label" htmlFor="rename-graph-input">
          {message("graph.graphName")}
        </label>
        <Input
          id="rename-graph-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          data-testid="rename-graph-name"
        />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {message("common.cancel")}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!name.trim()}
            data-testid="rename-graph-submit"
          >
            {message("common.rename")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({
  graph,
  onClose,
  onDeleted,
}: {
  graph: GraphSummary;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { message } = useI18n();
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={message("graph.deleteTitle")} onClose={onClose}>
      <p>
        {message("graph.deleteConfirm", { name: graph.name })}
      </p>
      <div className="dialog-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          {message("common.cancel")}
        </button>
        <button
          className="btn btn-danger"
          data-testid="confirm-delete-graph"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            deleteGraph(graph.id)
              .then(onDeleted)
              .catch((cause: unknown) => {
                // The dialog stays open with the graph still listed behind it,
                // which says nothing about why.
                setBusy(false);
                notify.failure(message("failure.deleteGraph", { name: graph.name }), cause);
              });
          }}
        >
          {message("common.deleteForever")}
        </button>
      </div>
    </Dialog>
  );
}

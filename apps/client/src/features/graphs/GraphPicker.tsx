import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ListTreeIcon, MoreHorizontalIcon } from "lucide-react";
import {
  deleteGraph,
  listGraphs,
  processPendingDelete,
  registerGraph,
  renameGraph,
  type GraphSummary,
} from "../../core-port/directory";
import { Callout, Dialog } from "../../ui/components";
import { Input } from "@/ui/shadcn/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";

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

  const create = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim() || "My graph";
    const graph = registerGraph(name);
    navigate(`/g/${graph.id}`);
  };

  return (
    <main className="picker">
      <div className="picker-inner">
        <p className="picker-wordmark">
          <ListTreeIcon aria-hidden />
          NeoSeq
        </p>
        <h1>Your graphs</h1>
        <p className="picker-lede">
          Your notes stay in this browser — no account, no server.
        </p>
        {state.status === "failed" && (
          <Callout tone="danger">Could not list local graphs: {state.message}</Callout>
        )}
        {state.status === "ready" && state.graphs.length === 0 && (
          <p className="picker-empty" data-testid="picker-empty">
            No graphs yet — your first one starts with a name.
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
                    Created {new Date(graph.created_at).toLocaleDateString(undefined, CREATED)}
                  </span>
                </button>
                {/* Both verbs live behind one named menu, so a destructive
                    action is never a pixel away from the open target. The class
                    reveals it on hover and on :focus-within. */}
                <div className="graph-actions">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className="icon-btn" aria-label={`Actions for ${graph.name}`}>
                        <MoreHorizontalIcon aria-hidden />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setRenaming(graph)}>
                        Rename graph
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setDeleting(graph)}
                      >
                        Delete graph…
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
            placeholder="New graph name"
            aria-label="New graph name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            data-testid="new-graph-name"
          />
          <button className="btn btn-primary" type="submit" data-testid="create-graph">
            Create
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
  const [name, setName] = useState(graph.name);
  return (
    <Dialog title="Rename graph" onClose={onClose}>
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
          Graph name
        </label>
        <Input
          id="rename-graph-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          data-testid="rename-graph-name"
        />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!name.trim()}
            data-testid="rename-graph-submit"
          >
            Rename
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title="Delete graph" onClose={onClose}>
      <p>
        Permanently delete <strong>{graph.name}</strong> and all of its notes from this browser?
        This cannot be undone.
      </p>
      {error && <p className="field-error">{error}</p>}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn-danger"
          data-testid="confirm-delete-graph"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            deleteGraph(graph.id)
              .then(onDeleted)
              .catch((cause) => {
                setBusy(false);
                setError(cause instanceof Error ? cause.message : String(cause));
              });
          }}
        >
          Delete forever
        </button>
      </div>
    </Dialog>
  );
}

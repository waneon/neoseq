import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { CloudIcon, DownloadIcon, MoreHorizontalIcon, UploadIcon } from "lucide-react";
import {
  deleteGraph,
  exportGraphArchive,
  importGraphArchive,
  listGraphs,
  processPendingDelete,
  registerGraph,
  registerRemoteGraph,
  renameGraph,
  type GraphSummary,
} from "../../core-port/directory";
import { createRemoteGraph, listRemoteGraphs } from "../sync/api";
import { writeAuthSession } from "../sync/auth";
import { Callout, ConfirmDialog, Dialog } from "../../ui/components";
import { Wordmark } from "../../ui/brand";
import { useNotify } from "../notify/context";
import { Input } from "@/ui/shadcn/input";
import { Button } from "@/ui/shadcn/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { configuredTimezone } from "../../entities/journal";
import { useI18n } from "../../i18n";
import type { AsyncRequestState } from "../../lib/async";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; graphs: GraphSummary[] }
  | { status: "failed"; message: string };

type GraphDialog =
  | { kind: "rename"; graph: GraphSummary }
  | { kind: "delete"; graph: GraphSummary }
  | { kind: "remote-create" }
  | null;

const CREATED = { day: "numeric", month: "short", year: "numeric" } as const;

/**
 * The first screen. It carries no entrance animation on purpose: this container
 * is audited by axe the instant it mounts, and a surface fading in at partial
 * alpha composites its text against the background and fails contrast for every
 * child (designs/foundations.md § Motion).
 *
 * The empty state *is* the action — one sentence above the create form, not a
 * dashed box holding an instruction that points at a form below it.
 */
export function GraphPicker() {
  const { message, formatInstant } = useI18n();
  const notify = useNotify();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [newName, setNewName] = useState("");
  const [dialog, setDialog] = useState<GraphDialog>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const archiveInput = useRef<HTMLInputElement>(null);

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
    if (importing) return;
    const name = newName.trim() || message("graph.defaultName");
    const graph = registerGraph(name);
    navigate(`/g/${graph.id}`);
  };

  return (
    <main className="picker">
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
                  <span className="graph-card-avatar" aria-hidden>
                    {[...graph.name.trim()][0] ?? "·"}
                  </span>
                  <span className="graph-card-text">
                    <span className="name">{graph.name}</span>
                    <span className="meta">
                      {graph.kind === "remote" && (
                        <>
                          <span className="graph-remote-label">
                            <CloudIcon aria-hidden />
                            {message("graph.remote")}
                          </span>
                          {" · "}
                        </>
                      )}
                      {message("graph.created", {
                        date: formatInstant(graph.created_at, configuredTimezone(), CREATED),
                      })}
                    </span>
                  </span>
                </button>
                {/* Maintenance verbs live behind one named menu, so a destructive
                    action is never a pixel away from the open target. The class
                    reveals it on hover and on :focus-within. */}
                <div className="graph-actions">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon"
                        aria-label={message("graph.actionsFor", { name: graph.name })}
                        data-graph-actions={graph.id}
                      >
                        <MoreHorizontalIcon aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuGroup>
                        <DropdownMenuItem
                          onSelect={() => setDialog({ kind: "rename", graph })}
                        >
                          {message("graph.rename")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={exporting !== null}
                          onSelect={() => {
                            setExporting(graph.id);
                            void exportGraphArchive(graph.id, graph.name)
                              .then((bytes) => downloadArchive(bytes, graph.name))
                              .catch((cause: unknown) => {
                                notify.failure(message("failure.exportGraph", { name: graph.name }), cause);
                              })
                              .finally(() => setExporting(null));
                          }}
                          data-testid={`export-graph-${graph.name}`}
                        >
                          <DownloadIcon aria-hidden />
                          {exporting === graph.id
                            ? message("graph.exporting")
                            : message("graph.export")}
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setDialog({ kind: "delete", graph })}
                        >
                          {message("graph.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            ))}
          </ul>
        )}
        {/* Name it, then make it: the field and the verb it answers to sit on
            one line, so the primary path through this screen is a single
            gesture. The remote graph is the second path and reads as one —
            below, quiet, and behind a rule. */}
        <form className="picker-new" onSubmit={create}>
          <div className="picker-new-row">
            <Input
              placeholder={message("graph.newName")}
              aria-label={message("graph.newName")}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              data-testid="new-graph-name"
            />
            <Button
              type="submit"
              disabled={importing}
              data-testid="create-graph"
            >
              {message("graph.createLocal")}
            </Button>
          </div>
          <div className="picker-new-actions">
            <Button
              variant="ghost"
              disabled={importing}
              onClick={() => archiveInput.current?.click()}
              data-testid="import-graph"
            >
              <UploadIcon data-icon="inline-start" aria-hidden />
              {importing ? message("graph.importing") : message("graph.import")}
            </Button>
            <input
              ref={archiveInput}
              className="sr-only"
              type="file"
              accept=".neoseq,application/vnd.neoseq.graph+zip"
              tabIndex={-1}
              aria-hidden
              data-testid="import-graph-file"
              onChange={(event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                if (!file) return;
                setImporting(true);
                void file.arrayBuffer()
                  .then((bytes) => importGraphArchive(bytes, message("graph.importedName")))
                  .then((graph) => navigate(`/g/${graph.id}`))
                  .catch((cause: unknown) => {
                    notify.failure(message("failure.importGraph"), cause);
                  })
                  .finally(() => {
                    input.value = "";
                    setImporting(false);
                  });
              }}
            />
            <Button
              variant="ghost"
              disabled={importing}
              onClick={() => setDialog({ kind: "remote-create" })}
              data-testid="create-remote-graph"
            >
              <CloudIcon aria-hidden />
              {message("graph.createRemote")}
            </Button>
          </div>
        </form>
      </div>

      {dialog?.kind === "rename" && (
        <RenameDialog
          graph={dialog.graph}
          onClose={() => setDialog(null)}
          onRenamed={() => {
            setDialog(null);
            void refresh();
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteDialog
          graph={dialog.graph}
          returnFocus={() =>
            document.querySelector<HTMLButtonElement>(
              `[data-graph-actions="${CSS.escape(dialog.graph.id)}"]`,
            )}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            setDialog(null);
            void refresh();
          }}
        />
      )}
      {dialog?.kind === "remote-create" && (
        <RemoteCreateDialog
          initialName={newName.trim() || message("graph.defaultName")}
          onClose={() => setDialog(null)}
          onCreated={(graph) => navigate(`/g/${graph.id}`)}
        />
      )}
    </main>
  );
}

function downloadArchive(bytes: ArrayBuffer, graphName: string): void {
  const blob = new Blob([bytes], { type: "application/vnd.neoseq.graph+zip" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `${safeFilename(graphName)}.neoseq`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
}

function safeFilename(value: string): string {
  const cleaned = value.trim().replace(/[\\/:*?"<>|]+/gu, "-").replace(/\s+/gu, " ");
  return cleaned || "graph";
}

function RemoteCreateDialog({
  initialName,
  onClose,
  onCreated,
}: {
  initialName: string;
  onClose: () => void;
  onCreated: (graph: GraphSummary) => void;
}) {
  const { message } = useI18n();
  const [name, setName] = useState(initialName);
  const [serverUrl, setServerUrl] = useState(window.location.origin);
  const [principal, setPrincipal] = useState("");
  const [token, setToken] = useState("");
  const [request, setRequest] = useState<AsyncRequestState>({ status: "idle" });
  const busy = request.status === "busy";

  const auth = () => ({ principal: principal.trim(), token: token.trim() });
  const remember = () => writeAuthSession(serverUrl, auth());

  const connectAvailable = () => {
    setRequest({ status: "busy" });
    remember();
    listRemoteGraphs(serverUrl, auth())
      .then(({ graphs }) => {
        if (graphs.length === 0) {
          setRequest({ status: "failed", message: message("graph.noRemoteGraphs") });
          return;
        }
        // The server knows ids, not names — the typed name goes to the first
        // graph, and the rest take a readable numbered variant of it rather
        // than an opaque id as their card title.
        const base = name.trim() || message("graph.defaultName");
        const registered = graphs.map((graph, index) =>
          registerRemoteGraph(
            graph.graph_id,
            index === 0 ? base : `${base} (${index + 1})`,
            serverUrl,
          ),
        );
        onCreated(registered[0]);
      })
      .catch(() => {
        setRequest({ status: "failed", message: message("graph.connectRemoteFailed") });
      });
  };

  return (
    <Dialog title={message("graph.remoteCreateTitle")} onClose={onClose}>
      <p className="dialog-lede">{message("graph.remoteCreateDetail")}</p>
      {request.status === "failed" && <Callout tone="danger">{request.message}</Callout>}
      <form
        className="remote-form"
        onSubmit={(event) => {
          event.preventDefault();
          setRequest({ status: "busy" });
          remember();
          createRemoteGraph(serverUrl, auth())
            .then(({ graph_id }) => {
              onCreated(registerRemoteGraph(graph_id, name.trim(), serverUrl));
            })
            .catch(() => {
              setRequest({ status: "failed", message: message("graph.createRemoteFailed") });
            });
        }}
      >
        <label className="field-label" htmlFor="remote-graph-name">{message("graph.graphName")}</label>
        <Input id="remote-graph-name" value={name} onChange={(event) => setName(event.target.value)} />
        <label className="field-label" htmlFor="remote-server-url">{message("graph.serverUrl")}</label>
        <Input id="remote-server-url" type="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} />
        <label className="field-label" htmlFor="remote-principal">{message("graph.principal")}</label>
        <Input id="remote-principal" autoComplete="username" value={principal} onChange={(event) => setPrincipal(event.target.value)} />
        <label className="field-label" htmlFor="remote-token">{message("graph.token")}</label>
        <Input id="remote-token" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} />
        <div className="dialog-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{message("common.cancel")}</Button>
          <Button variant="secondary" onClick={connectAvailable} disabled={busy || !principal.trim() || !token.trim()}>
            {message("graph.connectRemote")}
          </Button>
          <Button type="submit" disabled={busy || !name.trim() || !principal.trim() || !token.trim()}>
            {message("graph.createRemote")}
          </Button>
        </div>
      </form>
    </Dialog>
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
          <Button variant="secondary" onClick={onClose}>
            {message("common.cancel")}
          </Button>
          <Button
            type="submit"
            disabled={!name.trim()}
            data-testid="rename-graph-submit"
          >
            {message("common.rename")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({
  graph,
  returnFocus,
  onClose,
  onDeleted,
}: {
  graph: GraphSummary;
  returnFocus: () => HTMLElement | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { message } = useI18n();
  const notify = useNotify();
  return (
    <ConfirmDialog
      title={message("graph.deleteTitle")}
      cancelLabel={message("common.cancel")}
      confirmLabel={message("common.deleteForever")}
      testId="confirm-delete-graph"
      returnFocus={returnFocus}
      onClose={onClose}
      onConfirm={async () => {
        await deleteGraph(graph.id);
        onDeleted();
      }}
      onConfirmError={(cause) =>
        notify.failure(message("failure.deleteGraph", { name: graph.name }), cause)}
    >
      {message("graph.deleteConfirm", { name: graph.name })}
    </ConfirmDialog>
  );
}

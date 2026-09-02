import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import {
  CloudIcon,
  DownloadIcon,
  HardDriveIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PlusIcon,
  UploadIcon,
} from "lucide-react";
import {
  deleteGraph,
  exportGraphArchive,
  installPreparedGraph,
  listGraphs,
  prepareGraphArchive,
  processPendingDelete,
  registerGraph,
  registerRemoteGraph,
  renameGraph,
  type GraphSummary,
} from "../../core-port/directory";
import {
  createRepositoryId,
  listRepositories,
  normalizeServerOrigin,
  registerRemoteRepository,
  removeRemoteRepository,
  repositoryLabel,
  ServerUrlError,
  subscribeRepositoryDirectory,
  LOCAL_REPOSITORY_ID,
  type RemoteRepository,
  type Repository,
} from "../repositories/directory";
import {
  createRemoteGraph,
  createSeededRemoteGraph,
  listRemoteGraphs,
  RemoteApiError,
} from "../sync/api";
import { clearAuthSession, readAuthSession, signIn, writeAuthSession } from "../sync/auth";
import { Callout, ConfirmDialog, Dialog } from "../../ui/components";
import { Wordmark } from "../../ui/brand";
import { useNotify } from "../notify/context";
import { Input } from "@/ui/shadcn/input";
import { Button } from "@/ui/shadcn/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/ui/shadcn/field";
import { Skeleton } from "@/ui/shadcn/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/shadcn/tabs";
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
import { graphPath } from "./routing";
import { repositoryCatalog, useRepositoryCatalogs } from "./useRepositoryCatalogs";
import { randomUUID } from "@/lib/crypto";

type GraphDialog =
  | { kind: "rename"; graph: GraphSummary }
  | { kind: "delete"; graph: GraphSummary }
  | { kind: "repository"; repository?: RemoteRepository }
  | { kind: "forget"; repository: RemoteRepository }
  | null;

const CREATED = { day: "numeric", month: "short", year: "numeric" } as const;
const SELECTED_REPOSITORY_KEY = "neoseq.selected-repository.v1";

export function GraphPicker() {
  const { message, formatInstant } = useI18n();
  const notify = useNotify();
  const navigate = useNavigate();
  const [repositories, setRepositories] = useState<Repository[]>(listRepositories);
  const [selectedId, setSelectedId] = useState(
    () => localStorage.getItem(SELECTED_REPOSITORY_KEY) ?? LOCAL_REPOSITORY_ID,
  );
  const [directoryReady, setDirectoryReady] = useState(false);
  const [newName, setNewName] = useState("");
  const [dialog, setDialog] = useState<GraphDialog>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const archiveInputs = useRef(new Map<string, HTMLInputElement>());
  const selected =
    repositories.find((repository) => repository.id === selectedId) ?? repositories[0];
  const { catalogs, refreshSelected } = useRepositoryCatalogs(selected, directoryReady);

  useEffect(
    () =>
      subscribeRepositoryDirectory(() => {
        setRepositories(listRepositories());
      }),
    [],
  );

  useEffect(() => {
    if (repositories.some((repository) => repository.id === selectedId)) return;
    setSelectedId(LOCAL_REPOSITORY_ID);
  }, [repositories, selectedId]);

  useEffect(() => {
    let active = true;
    void processPendingDelete().then(
      () => {
        if (active) setDirectoryReady(true);
      },
      () => {
        if (active) setDirectoryReady(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const chooseRepository = (repositoryId: string) => {
    localStorage.setItem(SELECTED_REPOSITORY_KEY, repositoryId);
    setSelectedId(repositoryId);
  };

  // Signing out keeps the account and its cached copies; only the session goes,
  // so the tab asks for the password again and everything is still there.
  const signOut = (repository: RemoteRepository) => {
    clearAuthSession(repository.id);
    refreshSelected();
  };

  const openGraph = (graph: GraphSummary) => {
    if (graph.kind === "remote") {
      registerRemoteGraph(graph.repository_id, graph.id, graph.name, graph.created_at, {
        role: graph.role,
        status: graph.status,
      });
    }
    navigate(graphPath(graph.repository_id, graph.id));
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || importing || creating) return;
    const name = newName.trim() || message("graph.defaultName");
    if (selected.kind === "local") {
      openGraph(registerGraph(name));
      return;
    }
    const auth = readAuthSession(selected.id);
    if (!auth) {
      setDialog({ kind: "repository", repository: selected });
      return;
    }
    setCreating(true);
    try {
      const { graph_id } = await createRemoteGraph(selected.origin, auth, name);
      openGraph(
        registerRemoteGraph(selected.id, graph_id, name, new Date().toISOString(), {
          role: "owner",
          status: "active",
        }),
      );
    } catch (cause) {
      notify.failure(message("graph.createRemoteFailed"), cause);
    } finally {
      setCreating(false);
    }
  };

  const importArchive = async (file: File) => {
    if (!selected) return;
    setImporting(true);
    const graphId = `g-${randomUUID()}`;
    try {
      const bytes = await file.arrayBuffer();
      const prepared = await prepareGraphArchive(
        bytes,
        message("graph.importedName"),
        selected.id,
        graphId,
      );
      let ready;
      if (selected.kind === "remote") {
        const auth = readAuthSession(selected.id);
        if (!auth) throw new Error("remote authentication required");
        const created = await createSeededRemoteGraph(
          selected.origin,
          auth,
          graphId,
          prepared.name,
          prepared.checkpoint,
          prepared.checkpoint_checksum,
        );
        if (created.checkpoint_checksum !== prepared.checkpoint_checksum) {
          throw new Error("remote checkpoint checksum mismatch");
        }
        ready = await installPreparedGraph(prepared, {
          history_epoch: created.history_epoch,
          role: "owner",
          status: "active",
        });
      } else {
        ready = await installPreparedGraph(prepared);
      }
      openGraph(ready);
    } catch (cause) {
      notify.failure(message("failure.importGraph"), cause);
    } finally {
      setImporting(false);
    }
  };

  const remote = selected?.kind === "remote" ? selected : null;

  return (
    <main className="picker">
      <div className="picker-inner">
        <p className="picker-wordmark">
          <Wordmark name={message("app.title")} />
        </p>
        <h1>{message("graph.yourGraphs")}</h1>
        <p className="picker-lede">
          {remote
            ? message("repository.remoteLede", { account: remote.username })
            : message("graph.lede")}
        </p>

        <Tabs value={selected?.id} onValueChange={chooseRepository}>
          <div className="repository-tabs-row">
            <TabsList aria-label={message("repository.tabsLabel")}>
              {repositories.map((repository) => (
                <TabsTrigger key={repository.id} value={repository.id}>
                  {repository.kind === "local" ? (
                    <HardDriveIcon aria-hidden />
                  ) : (
                    <CloudIcon aria-hidden />
                  )}
                  <span>{repositoryLabel(repository, message("repository.local"))}</span>
                </TabsTrigger>
              ))}
            </TabsList>
            <Button
              size="icon"
              variant="ghost"
              aria-label={message("repository.add")}
              data-testid="add-repository"
              onClick={() => setDialog({ kind: "repository" })}
            >
              <PlusIcon aria-hidden />
            </Button>
            {remote && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={message("repository.actions")}
                    data-testid="repository-actions"
                  >
                    <MoreHorizontalIcon aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      disabled={!readAuthSession(remote.id)}
                      onSelect={() => signOut(remote)}
                    >
                      <LogOutIcon aria-hidden />
                      {message("repository.signOut")}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setDialog({ kind: "forget", repository: remote })}
                    >
                      {message("repository.forget")}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          {repositories.map((repository) => {
            const catalog = repositoryCatalog(catalogs, repository.id);
            const repositoryRemote = repository.kind === "remote" ? repository : null;
            const initialLoading = catalog.status === "idle" || catalog.status === "loading";
            const busy = initialLoading || catalog.refreshing;
            return (
              <TabsContent
                key={repository.id}
                className="repository-panel"
                value={repository.id}
                aria-busy={busy}
              >
                {catalog.status === "failed" &&
                  (repositoryRemote ? (
                    <div className="repository-auth-required">
                      <Callout tone="danger">
                        {message("repository.unreachable", {
                          host: new URL(repositoryRemote.origin).host,
                        })}
                      </Callout>
                      <Button variant="secondary" onClick={refreshSelected}>
                        {message("common.retry")}
                      </Button>
                    </div>
                  ) : (
                    <Callout tone="danger">
                      {message("repository.listFailed", {
                        detail: message("error.storageCorrupt"),
                      })}
                    </Callout>
                  ))}
                {catalog.status === "auth" && repositoryRemote && (
                  <div className="repository-auth-required">
                    <Callout>{message("repository.signInRequired")}</Callout>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setDialog({ kind: "repository", repository: repositoryRemote })
                      }
                    >
                      {message("graph.signIn")}
                    </Button>
                  </div>
                )}
                {catalog.status === "ready" && catalog.stale && (
                  <Callout>{message("repository.cachedOnly")}</Callout>
                )}
                {initialLoading && catalog.graphs.length === 0 && (
                  <GraphListSkeleton label={message("repository.loading")} />
                )}
                {catalog.status === "ready" && catalog.graphs.length === 0 && (
                  <p className="picker-empty" data-testid="picker-empty">
                    {repositoryRemote ? message("repository.remoteEmpty") : message("graph.empty")}
                  </p>
                )}
                {catalog.graphs.length > 0 && (
                  <GraphList
                    graphs={catalog.graphs}
                    exporting={exporting}
                    formatDate={(date) => formatInstant(date, configuredTimezone(), CREATED)}
                    onOpen={openGraph}
                    onExport={(graph) => {
                      setExporting(graph.id);
                      void exportGraphArchive(graph.repository_id, graph.id, graph.name)
                        .then((bytes) => downloadArchive(bytes, graph.name))
                        .catch((cause: unknown) => {
                          notify.failure(
                            message("failure.exportGraph", { name: graph.name }),
                            cause,
                          );
                        })
                        .finally(() => setExporting(null));
                    }}
                    onRename={(graph) => setDialog({ kind: "rename", graph })}
                    onDelete={(graph) => setDialog({ kind: "delete", graph })}
                  />
                )}

                <form className="picker-new" onSubmit={(event) => void create(event)}>
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
                      disabled={importing || creating || catalog.status === "auth"}
                      data-testid="create-graph"
                    >
                      {creating
                        ? message("repository.creating")
                        : repositoryRemote
                          ? message("graph.createRemote")
                          : message("graph.createLocal")}
                    </Button>
                  </div>
                  <div className="picker-new-actions">
                    <Button
                      variant="ghost"
                      disabled={importing || creating || catalog.status === "auth"}
                      onClick={() => archiveInputs.current.get(repository.id)?.click()}
                      data-testid="import-graph"
                    >
                      <UploadIcon data-icon="inline-start" aria-hidden />
                      {importing ? message("graph.importing") : message("graph.import")}
                    </Button>
                    <input
                      ref={(input) => {
                        if (input) archiveInputs.current.set(repository.id, input);
                        else archiveInputs.current.delete(repository.id);
                      }}
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
                        void importArchive(file).finally(() => {
                          input.value = "";
                        });
                      }}
                    />
                  </div>
                </form>
              </TabsContent>
            );
          })}
        </Tabs>
      </div>

      {dialog?.kind === "rename" && (
        <RenameDialog
          graph={dialog.graph}
          onClose={() => setDialog(null)}
          onRenamed={() => {
            setDialog(null);
            refreshSelected();
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteDialog
          graph={dialog.graph}
          returnFocus={() =>
            document.querySelector<HTMLButtonElement>(
              `[data-graph-actions="${CSS.escape(dialog.graph.id)}"]`,
            )
          }
          onClose={() => setDialog(null)}
          onDeleted={() => {
            setDialog(null);
            refreshSelected();
          }}
        />
      )}
      {dialog?.kind === "repository" && (
        <RepositoryDialog
          repository={dialog.repository}
          onClose={() => setDialog(null)}
          onConnected={(repository) => {
            setDialog(null);
            chooseRepository(repository.id);
            setRepositories(listRepositories());
          }}
        />
      )}
      {dialog?.kind === "forget" && (
        <ForgetRepositoryDialog
          repository={dialog.repository}
          onClose={() => setDialog(null)}
          onForgotten={() => {
            setDialog(null);
            chooseRepository(LOCAL_REPOSITORY_ID);
            setRepositories(listRepositories());
          }}
        />
      )}
    </main>
  );
}

function GraphListSkeleton({ label }: { label: string }) {
  return (
    <div
      className="graph-list graph-list-loading"
      role="status"
      aria-label={label}
      data-testid="graph-list-loading"
    >
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="graph-card-placeholder" aria-hidden />
      ))}
    </div>
  );
}

function GraphList({
  graphs,
  exporting,
  formatDate,
  onOpen,
  onExport,
  onRename,
  onDelete,
}: {
  graphs: GraphSummary[];
  exporting: string | null;
  formatDate: (date: string) => string;
  onOpen: (graph: GraphSummary) => void;
  onExport: (graph: GraphSummary) => void;
  onRename: (graph: GraphSummary) => void;
  onDelete: (graph: GraphSummary) => void;
}) {
  const { message } = useI18n();
  return (
    <ul className="graph-list" data-testid="graph-list">
      {graphs.map((graph) => {
        const actions = graph.kind === "local" || graph.cached;
        return (
          <li key={`${graph.repository_id}:${graph.id}`} className="graph-card">
            <button
              className="graph-card-open"
              onClick={() => onOpen(graph)}
              data-testid={`open-graph-${graph.name}`}
            >
              <span className="graph-card-avatar" aria-hidden>
                {[...graph.name.trim()][0] ?? "·"}
              </span>
              <span className="graph-card-text">
                <span className="name">{graph.name}</span>
                <span className="meta">
                  {graph.role && <>{message(`graph.${graph.role}`)} · </>}
                  {message("graph.created", { date: formatDate(graph.created_at) })}
                  {graph.kind === "remote" && graph.cached && (
                    <> · {message("repository.availableOffline")}</>
                  )}
                </span>
              </span>
            </button>
            {actions && (
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
                      {graph.kind === "local" && (
                        <DropdownMenuItem onSelect={() => onRename(graph)}>
                          {message("graph.rename")}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        disabled={exporting !== null}
                        onSelect={() => onExport(graph)}
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
                      <DropdownMenuItem variant="destructive" onSelect={() => onDelete(graph)}>
                        {message(graph.kind === "local" ? "graph.delete" : "graph.removeReplica")}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function RepositoryDialog({
  repository,
  onClose,
  onConnected,
}: {
  repository?: RemoteRepository;
  onClose: () => void;
  onConnected: (repository: RemoteRepository) => void;
}) {
  const { message } = useI18n();
  const [serverUrl, setServerUrl] = useState(repository?.origin ?? window.location.origin);
  const [username, setUsername] = useState(repository?.username ?? "");
  const [password, setPassword] = useState("");
  const [persistent, setPersistent] = useState(true);
  const [request, setRequest] = useState<AsyncRequestState>({ status: "idle" });
  const busy = request.status === "busy";

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setRequest({ status: "busy" });
    const repositoryId = repository?.id ?? createRepositoryId();
    try {
      const origin = normalizeServerOrigin(serverUrl);
      const auth = await signIn(repositoryId, origin, username, password, persistent);
      if (repository && auth.principal !== repository.account_id) {
        clearAuthSession(repositoryId);
        throw new Error("repository account changed");
      }
      await listRemoteGraphs(origin, auth);
      const connected = repository ?? registerRemoteRepository(repositoryId, origin, auth);
      if (connected.id !== repositoryId) {
        writeAuthSession(connected.id, auth);
        clearAuthSession(repositoryId);
      }
      onConnected(connected);
    } catch (error) {
      setRequest({ status: "failed", message: connectFailure(error, serverUrl) });
    }
  };

  // Three different things go wrong here and each has its own remedy: a URL the
  // browser cannot use, a server it cannot reach, or a password it rejected.
  const connectFailure = (error: unknown, url: string): string => {
    if (error instanceof ServerUrlError) {
      return message(
        error.problem === "mixed-content" ? "repository.urlMixedContent" : "repository.urlInvalid",
      );
    }
    if (error instanceof RemoteApiError && (error.status === 401 || error.status === 403)) {
      return message("graph.signInFailed");
    }
    if (error instanceof Error && error.message === "repository account changed") {
      return message("graph.signInFailed");
    }
    let host = url.trim();
    try {
      host = new URL(url, window.location.origin).host;
    } catch {
      // The typed text is the best name we have for a server we never parsed.
    }
    return message("repository.unreachable", { host });
  };

  return (
    <Dialog
      title={message(repository ? "repository.reconnectTitle" : "repository.addTitle")}
      onClose={onClose}
    >
      <p className="dialog-lede">{message("repository.addDetail")}</p>
      {request.status === "failed" && <Callout tone="danger">{request.message}</Callout>}
      <form onSubmit={(event) => void connect(event)}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="repository-server-url">{message("graph.serverUrl")}</FieldLabel>
            <Input
              id="repository-server-url"
              type="url"
              value={serverUrl}
              disabled={Boolean(repository)}
              onChange={(event) => setServerUrl(event.target.value)}
            />
            <FieldDescription>{message("repository.urlDetail")}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="repository-username">{message("graph.username")}</FieldLabel>
            <Input
              id="repository-username"
              autoComplete="username"
              value={username}
              disabled={Boolean(repository)}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="repository-password">{message("graph.password")}</FieldLabel>
            <Input
              id="repository-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <FieldDescription>{message("repository.passwordDetail")}</FieldDescription>
          </Field>
          <Field className="repository-session-field">
            <FieldLabel htmlFor="repository-persistent-session">
              <input
                id="repository-persistent-session"
                type="checkbox"
                checked={persistent}
                onChange={(event) => setPersistent(event.target.checked)}
              />
              <span>{message("repository.keepSignedIn")}</span>
            </FieldLabel>
            <FieldDescription>{message("repository.keepSignedInDetail")}</FieldDescription>
          </Field>
        </FieldGroup>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {message("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || !username.trim() || !password}>
            {message("graph.signIn")}
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
            renameGraph(graph.repository_id, graph.id, name);
            onRenamed();
          }
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="rename-graph-input">{message("graph.graphName")}</FieldLabel>
            <Input
              id="rename-graph-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              data-testid="rename-graph-name"
            />
          </Field>
        </FieldGroup>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={onClose}>
            {message("common.cancel")}
          </Button>
          <Button type="submit" disabled={!name.trim()} data-testid="rename-graph-submit">
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
  // Deleting a local graph destroys the only copy; removing a remote graph
  // drops this device's replica while the server keeps the graph.
  const local = graph.kind === "local";
  return (
    <ConfirmDialog
      title={message(local ? "graph.deleteTitle" : "graph.removeReplicaTitle")}
      cancelLabel={message("common.cancel")}
      confirmLabel={message(local ? "common.deleteForever" : "graph.removeReplicaAction")}
      testId="confirm-delete-graph"
      returnFocus={returnFocus}
      onClose={onClose}
      onConfirm={async () => {
        await deleteGraph(graph.repository_id, graph.id);
        onDeleted();
      }}
      onConfirmError={(cause) =>
        notify.failure(message("failure.deleteGraph", { name: graph.name }), cause)
      }
    >
      {message(local ? "graph.deleteConfirm" : "graph.removeReplicaConfirm", { name: graph.name })}
    </ConfirmDialog>
  );
}

function ForgetRepositoryDialog({
  repository,
  onClose,
  onForgotten,
}: {
  repository: RemoteRepository;
  onClose: () => void;
  onForgotten: () => void;
}) {
  const { message } = useI18n();
  const notify = useNotify();
  const host = new URL(repository.origin).host;
  return (
    <ConfirmDialog
      title={message("repository.forgetTitle")}
      cancelLabel={message("common.cancel")}
      confirmLabel={message("repository.forgetAction")}
      testId="confirm-forget-repository"
      returnFocus={() =>
        document.querySelector<HTMLButtonElement>("[data-testid=repository-actions]")
      }
      onClose={onClose}
      onConfirm={async () => {
        // Replicas first: a directory entry that outlives its account is
        // recoverable by reconnecting, a replica without its directory is not.
        const replicas = (await listGraphs(repository.id)).filter((graph) => graph.cached);
        for (const replica of replicas) await deleteGraph(repository.id, replica.id);
        clearAuthSession(repository.id);
        removeRemoteRepository(repository.id);
        onForgotten();
      }}
      onConfirmError={(cause) =>
        notify.failure(message("failure.forgetRepository", { host }), cause)
      }
    >
      {message("repository.forgetConfirm", { account: repository.username, host })}
    </ConfirmDialog>
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
  const cleaned = value
    .trim()
    .replace(/[\\/:*?"<>|]+/gu, "-")
    .replace(/\s+/gu, " ");
  return cleaned || "graph";
}

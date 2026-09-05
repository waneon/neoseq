import { useSyncExternalStore } from "react";
import type { Command, InlineContent } from "../../../core-port/commands";
import type { CommandResult } from "../../../generated/core-port";
import type { GraphSession } from "../../../core-port/session";
import { CorePortFailure } from "../../../core-worker";
import {
  findBlock,
  findOutline,
  outlineOwnerKey,
  type ContentRangeChange,
  type BlockSnapshot,
  type OutlineOwner,
  type PageDirectoryEntry,
} from "../../../core-port/snapshot";
import {
  editBuffer,
  projectBuffer,
  spliceBuffer,
  bufferAtoms,
  bufferCommand,
  bufferIsClean,
  createContentBuffer,
  sameContent,
  settleBuffer,
  restoreBuffer,
  rebaseBuffer,
  inlineContent,
  type ContentAtom,
  type ContentBuffer,
} from "./content-buffer";

const EMPTY_BUFFERS: ReadonlyMap<string, ContentBuffer> = new Map();

export interface ContentProjectionChange {
  before: readonly ContentAtom[];
  after: readonly ContentAtom[];
  mapping: readonly ContentRangeChange[];
  beforeDirectory: readonly PageDirectoryEntry[];
  afterDirectory: readonly PageDirectoryEntry[];
}

/** A graph-scoped edit target, independent of the surface that currently displays it. */
export class BlockContentSession {
  private readonly listeners = new Set<(change: ContentProjectionChange) => void>();
  constructor(
    private readonly store: ContentSessions,
    readonly owner: OutlineOwner,
    readonly blockId: string,
  ) {}

  getSnapshot = (): ContentBuffer | undefined =>
    this.store.buffers(this.owner).get(this.blockId) ??
    this.store.canonical(this.owner, this.blockId);

  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  get hasPendingActions(): boolean {
    return this.store.hasPendingActions(this);
  }

  get buffer(): ContentBuffer {
    const buffer = this.getSnapshot();
    if (!buffer) throw new Error("Content session has no source");
    return buffer;
  }

  replace(buffer: ContentBuffer): void {
    this.store.set(this, buffer);
  }

  edit(value: string, directory: readonly PageDirectoryEntry[]): void {
    this.replace(editBuffer(this.buffer, projectBuffer(this.buffer, directory), value));
  }

  splice(index: number, deleteCount: number, insert: readonly InlineContent[]): void {
    this.replace(spliceBuffer(this.buffer, index, deleteCount, insert));
  }

  /** Discard an explicit provisional edit or restore a history result. */
  reset(): void {
    this.store.reset(this);
  }

  adopt(blockId: string): void {
    const buffer = this.store.buffers(this.owner).get(this.blockId);
    if (buffer && !bufferIsClean(buffer)) this.store.target(this.owner, blockId).replace(buffer);
    this.reset();
  }

  /** All surfaces submit against one target buffer and keep subsequent input. */
  submit(actions: readonly Command[] = []): Promise<{ newerInput: boolean }> {
    return this.store.submit(this, actions);
  }

  /** A structural host has already projected this command's resulting source. */
  applyProjected(command: Command): Promise<CommandResult | null> {
    return this.store.applyProjected(this, command);
  }

  observe = (listener: (change: ContentProjectionChange) => void): (() => void) => {
    if (!this.store.buffers(this.owner).has(this.blockId)) {
      const canonical = this.store.canonical(this.owner, this.blockId);
      if (canonical) this.replace(canonical);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.store.release(this);
    };
  };

  get observed(): boolean {
    return this.listeners.size > 0;
  }

  publish(change: ContentProjectionChange): void {
    for (const listener of this.listeners) listener(change);
  }

  setComposing(composing: boolean): void {
    this.store.setComposing(this, composing);
  }
}

export class ContentSessions {
  private readonly canonicalBuffers = new WeakMap<BlockSnapshot, ContentBuffer>();
  private readonly owners = new Map<string, ReadonlyMap<string, ContentBuffer>>();
  private readonly ownerRefs = new Map<string, OutlineOwner>();
  private readonly targets = new Map<string, BlockContentSession>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private readonly retryActions = new Map<BlockContentSession, readonly Command[]>();
  private readonly pending = new Map<BlockContentSession, number>();
  private readonly unavailable = new Map<BlockContentSession, string>();
  private readonly compositions = new Map<
    BlockContentSession,
    {
      content: readonly InlineContent[] | null;
      mapping: ContentRangeChange[];
      beforeDirectory: readonly PageDirectoryEntry[];
      afterDirectory: readonly PageDirectoryEntry[];
    }
  >();

  constructor(private readonly graph?: GraphSession) {
    if (!graph) return;
    let revision = graph.getState().canonicalRevision;
    let directory = graph.getState().snapshot.page_directory ?? [];
    const unsubscribe = graph.subscribe(() => {
      const state = graph.getState();
      if (state.status === "closed") {
        unsubscribe();
        return;
      }
      if (revision === state.canonicalRevision) return;
      revision = state.canonicalRevision;
      const nextDirectory = state.snapshot.page_directory ?? [];
      const updates = state.lastChange?.changes.blocks ?? [];
      for (const [key, buffers] of this.owners) {
        const owner = this.ownerRefs.get(key)!;
        const next = new Map(buffers);
        for (const [id, buffer] of buffers) {
          const target = this.target(owner, id);
          const canonical = this.canonical(owner, id);
          if (!canonical) {
            if (bufferIsClean(buffer) && !this.pending.has(target)) next.delete(id);
            else
              this.unavailable.set(
                target,
                "The edited block is no longer available. Your draft has been retained.",
              );
            continue;
          }
          const update = updates.find(
            (entry) => entry.block_id === id && outlineOwnerKey(entry.owner) === key,
          );
          const composition = this.compositions.get(target);
          if (composition) {
            composition.content = inlineContent(canonical.source);
            for (const change of update?.mapping ?? []) composition.mapping.push(change);
            composition.afterDirectory = nextDirectory;
            continue;
          }
          let value = buffer;
          let mapping: readonly ContentRangeChange[] = [];
          if (update?.mapping.length || !sameContent(buffer.source, canonical.source)) {
            if (this.pending.has(target)) continue;
            const rebased = update && rebaseBuffer(buffer, update.content, update.mapping);
            if (rebased) {
              value = rebased.buffer;
              mapping = rebased.mapping;
            } else if (bufferIsClean(buffer)) value = canonical;
            else {
              this.unavailable.set(
                target,
                "The document changed while this edit was disconnected. Your draft has been retained. Copy it before reloading.",
              );
              continue;
            }
            next.set(id, value);
          }
          target.publish({
            before: bufferAtoms(buffer),
            after: bufferAtoms(value),
            mapping,
            beforeDirectory: directory,
            afterDirectory: nextDirectory,
          });
        }
        if (
          next.size !== buffers.size ||
          [...next].some(([id, buffer]) => buffers.get(id) !== buffer)
        )
          this.replace(owner, next);
      }
      directory = nextDirectory;
    });
  }

  setComposing(target: BlockContentSession, composing: boolean): void {
    if (composing) {
      const directory = this.graph?.getState().snapshot.page_directory ?? [];
      this.compositions.set(target, {
        content: null,
        mapping: [],
        beforeDirectory: directory,
        afterDirectory: directory,
      });
      return;
    }
    const pending = this.compositions.get(target);
    this.compositions.delete(target);
    if (!pending?.content) return;
    const before = target.buffer;
    const rebased = rebaseBuffer(before, pending.content, pending.mapping);
    if (!rebased) {
      this.unavailable.set(
        target,
        "The document changed while you were composing text. Your draft has been retained. Copy it before reloading.",
      );
      return;
    }
    target.publish({
      before: bufferAtoms(before),
      after: bufferAtoms(rebased.buffer),
      mapping: rebased.mapping,
      beforeDirectory: pending.beforeDirectory,
      afterDirectory: pending.afterDirectory,
    });
    target.replace(rebased.buffer);
  }

  canonical(owner: OutlineOwner, blockId: string): ContentBuffer | undefined {
    if (!this.graph) return undefined;
    const outline = findOutline(this.graph.getState().snapshot, owner);
    const block = outline && findBlock(outline, blockId);
    if (!block) return undefined;
    let buffer = this.canonicalBuffers.get(block);
    if (!buffer) {
      buffer = createContentBuffer(block.content);
      this.canonicalBuffers.set(block, buffer);
    }
    return buffer;
  }

  async applyProjected(
    target: BlockContentSession,
    command: Command,
  ): Promise<CommandResult | null> {
    if (!this.graph) throw new Error("Content submission requires a graph session");
    try {
      return await this.graph.executePrepared(() => {
        this.pending.set(target, (this.pending.get(target) ?? 0) + 1);
        return command;
      });
    } finally {
      const pending = (this.pending.get(target) ?? 1) - 1;
      if (pending === 0) this.pending.delete(target);
      else this.pending.set(target, pending);
    }
  }

  async submit(
    target: BlockContentSession,
    actions: readonly Command[],
  ): Promise<{ newerInput: boolean }> {
    if (!this.graph) throw new Error("Content submission requires a graph session");
    let submitted: ContentBuffer | undefined;
    let submittedActions: readonly Command[] = [];
    try {
      await this.graph.executePrepared(() => {
        const unavailable = this.unavailable.get(target);
        if (unavailable)
          throw new CorePortFailure({
            code: "invalid_request",
            message: unavailable,
            retryable: false,
          });
        const buffer = target.buffer;
        const content = bufferCommand(buffer, target.owner, target.blockId);
        submittedActions = [...(this.retryActions.get(target) ?? []), ...actions];
        const commands = [...submittedActions, ...(content ? [content] : [])];
        if (commands.length === 0) return null;
        this.retryActions.delete(target);
        submitted = buffer;
        this.pending.set(target, (this.pending.get(target) ?? 0) + 1);
        target.replace(settleBuffer(buffer));
        return commands.length === 1 ? commands[0] : { type: "batch", commands };
      });
      if (!submitted) return { newerInput: false };
      const newerInput = !sameContent(bufferAtoms(target.buffer), bufferAtoms(submitted));
      const canonical = this.canonical(target.owner, target.blockId);
      if (!newerInput) {
        target.replace(canonical ?? settleBuffer(submitted));
      } else if (!canonical || !sameContent(target.buffer.source, canonical.source)) {
        this.unavailable.set(
          target,
          "The document changed before your edit finished saving. Your newer input has been retained. Copy it before reloading.",
        );
      }
      return { newerInput };
    } catch (error) {
      if (submitted && !(error instanceof CorePortFailure && error.applied)) {
        if (submittedActions.length) this.retryActions.set(target, submittedActions);
        target.replace(restoreBuffer(submitted, target.buffer));
      }
      throw error;
    } finally {
      if (submitted) {
        const pending = (this.pending.get(target) ?? 1) - 1;
        if (pending === 0) this.pending.delete(target);
        else this.pending.set(target, pending);
        this.release(target);
      }
    }
  }

  hasPendingActions(target: BlockContentSession): boolean {
    return this.retryActions.has(target);
  }

  buffers(owner: OutlineOwner): ReadonlyMap<string, ContentBuffer> {
    return this.owners.get(outlineOwnerKey(owner)) ?? EMPTY_BUFFERS;
  }

  reset(target: BlockContentSession): void {
    this.retryActions.delete(target);
    this.unavailable.delete(target);
    this.set(target, target.observed ? this.canonical(target.owner, target.blockId) : undefined);
  }

  set(target: BlockContentSession, buffer: ContentBuffer | undefined): void {
    if (this.buffers(target.owner).get(target.blockId) === buffer) return;
    const next = new Map(this.buffers(target.owner));
    if (buffer) next.set(target.blockId, buffer);
    else next.delete(target.blockId);
    this.replace(target.owner, next);
  }

  private replace(owner: OutlineOwner, buffers: ReadonlyMap<string, ContentBuffer>): void {
    if (this.buffers(owner) === buffers) return;
    const next = buffers;
    this.owners.set(outlineOwnerKey(owner), next);
    this.ownerRefs.set(outlineOwnerKey(owner), owner);
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  release(target: BlockContentSession): void {
    if (target.observed || this.pending.has(target) || this.compositions.has(target)) return;
    const buffers = this.buffers(target.owner);
    const buffer = buffers.get(target.blockId);
    if (this.retryActions.has(target) || (buffer && !bufferIsClean(buffer))) return;
    const next = new Map(buffers);
    next.delete(target.blockId);
    const ownerKey = outlineOwnerKey(target.owner);
    if (next.size) this.owners.set(ownerKey, next);
    else {
      this.owners.delete(ownerKey);
      this.ownerRefs.delete(ownerKey);
    }
    this.unavailable.delete(target);
    // Keep this lightweight identity while the graph lives: React may still
    // hold the handle across an effect cleanup and immediate reattachment.
  }

  open(
    owner: OutlineOwner,
    blockId: string,
    content: readonly InlineContent[],
  ): BlockContentSession {
    const target = this.target(owner, blockId);
    if (!this.buffers(owner).has(blockId)) target.replace(createContentBuffer(content));
    return target;
  }

  target(owner: OutlineOwner, blockId: string): BlockContentSession {
    const key = `${outlineOwnerKey(owner)}:${blockId}`;
    let target = this.targets.get(key);
    if (!target) {
      target = new BlockContentSession(this, owner, blockId);
      this.targets.set(key, target);
    }
    return target;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.revision;
}

const graphSessions = new WeakMap<GraphSession, ContentSessions>();

export function contentSessionsFor(graph: GraphSession): ContentSessions {
  let sessions = graphSessions.get(graph);
  if (!sessions) {
    sessions = new ContentSessions(graph);
    graphSessions.set(graph, sessions);
  }
  return sessions;
}

export function useContentSessions(graph: GraphSession, owner?: OutlineOwner): ContentSessions {
  const sessions = contentSessionsFor(graph);
  const snapshot = () => (owner ? sessions.buffers(owner) : sessions.getSnapshot());
  useSyncExternalStore(sessions.subscribe, snapshot, snapshot);
  return sessions;
}

export function useContentBuffer(target: BlockContentSession): ContentBuffer | undefined {
  return useSyncExternalStore(target.subscribe, target.getSnapshot, target.getSnapshot);
}

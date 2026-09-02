// Component test harness: real GraphSession over the in-memory FakeCorePort,
// mounted inside the app's route shape so router hooks resolve.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { afterEach } from "vitest";
import type userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { useMemo, type ReactElement, type ReactNode } from "react";
import { GraphSession } from "../../src/core-port/session";
import { FakeCorePort, openFakeSession } from "../../src/core-port/testing/fake-core-port";
import { resetAppSettingsCache } from "../../src/entities/settings";
import { resetQueryDisclosure } from "../../src/features/query/presentation";
import { queryExecutionStore } from "../../src/features/query/execution";
import { NotifyProvider } from "../../src/features/notify/context";
import { HistoryProvider } from "../../src/features/history/context";
import { LocaleProvider } from "../../src/i18n";
import { SessionContext } from "../../src/features/shell/session-context";
import { JournalView } from "../../src/features/journal/JournalView";
import { PageView } from "../../src/features/page/PageView";
import { TagsView } from "../../src/features/tags/TagsView";
import { TagView } from "../../src/features/tags/TagView";
import {
  CommandContext,
  createContextualHandlerRegistry,
  type CommandBridge,
  type PageActions,
} from "../../src/features/commands/context";

export const GRAPH_ID = "test-graph";

// A session holds the graph lease until it closes, exactly as in the browser,
// so every mounted session is closed once its tree is gone: on an explicit
// unmount, and after each test for the trees testing-library tears down.
const openSessions = new Set<GraphSession>();

afterEach(async () => {
  cleanup();
  const sessions = [...openSessions];
  openSessions.clear();
  await Promise.all(sessions.map((session) => session.close()));
});

export interface Harness {
  session: GraphSession;
  port: FakeCorePort;
  view: RenderResult;
  router: ReturnType<typeof createMemoryRouter>;
  /** Runs optional work and flushes its query answers in one React interaction. */
  settle: {
    (): Promise<void>;
    <T>(work: () => T | Promise<T>): Promise<T>;
  };
}

/** Explicit command wiring for feature tests that intentionally omit GraphShell. */
export function TestCommandProvider({ children }: { children: ReactNode }) {
  const commands = useMemo<CommandBridge>(() => {
    const blocks = createContextualHandlerRegistry<(key?: string) => void>();
    let pageProperties: ((key?: string) => void) | null = null;
    let pageActions: PageActions | null = null;
    return {
      openPalette: () => {},
      openShortcuts: () => {},
      openSettings: () => {},
      registerBlockProperties: blocks.register,
      setPageProperties: (handler) => {
        pageProperties = handler;
      },
      setPageActions: (actions) => {
        pageActions = actions;
      },
      availability: () => ({
        properties: blocks.current() !== undefined || pageProperties !== null,
        pageInfo: pageActions !== null,
        pageDelete: pageActions?.remove !== undefined,
      }),
      requestProperties: (key) => {
        const handler = blocks.current() ?? pageProperties;
        if (!handler) return false;
        handler(key);
        return true;
      },
      requestPageInfo: () => {
        if (!pageActions) return false;
        pageActions.info();
        return true;
      },
      requestPageDelete: () => {
        const remove = pageActions?.remove;
        if (!remove) return false;
        remove();
        return true;
      },
    };
  }, []);
  return <CommandContext.Provider value={commands}>{children}</CommandContext.Provider>;
}

export async function mountAt(initialPath: string, custom?: ReactElement): Promise<Harness> {
  // App settings and query disclosure are browser-wide and cached, so a test that
  // changed one must not leak it into the next mount.
  resetAppSettingsCache();
  resetQueryDisclosure();
  const { session, port } = await openFakeSession(GRAPH_ID);
  openSessions.add(session);
  // GraphSession is an external store. Production receives its notifications
  // from Worker promises; component tests must mark that same boundary as a
  // React update instead of forcing every test to wrap domain setup commands.
  const subscribe = session.subscribe;
  session.subscribe = (listener) =>
    subscribe(() => {
      act(listener);
    });
  const queryStore = queryExecutionStore(session);
  const router = createMemoryRouter(
    [
      {
        path: "/g/:graphId",
        element: (
          <TestCommandProvider>
            <SessionContext.Provider value={session}>
              <HistoryProvider session={session} graphId={GRAPH_ID}>
                <Outlet />
              </HistoryProvider>
            </SessionContext.Provider>
          </TestCommandProvider>
        ),
        children: [
          { path: "journal", element: custom ?? <JournalView /> },
          { path: "journal/:date", element: custom ?? <JournalView /> },
          { path: "tags", element: custom ?? <TagsView /> },
          { path: "t/:tagId", element: custom ?? <TagView /> },
          { path: "p/:pageId", element: custom ?? <PageView /> },
          { path: "custom", element: custom ?? <div /> },
        ],
      },
      { path: "*", element: <div data-testid="elsewhere" /> },
    ],
    { initialEntries: [initialPath] },
  );
  // The notification layer wraps the router in the real app too, so a failure
  // raised by a routed view has the same surface here as in production.
  const view = render(
    <LocaleProvider initialPreference="en">
      <NotifyProvider>
        <RouterProvider router={router} />
      </NotifyProvider>
    </LocaleProvider>,
  );
  async function settle(): Promise<void>;
  async function settle<T>(work: () => T | Promise<T>): Promise<T>;
  async function settle<T>(work?: () => T | Promise<T>): Promise<T | void> {
    let value: T | undefined;
    await act(async () => {
      value = await work?.();
      // Let effects claim their query before taking the store's idle snapshot.
      await Promise.resolve();
      await queryStore.whenIdle();
    });
    return value;
  }
  await settle();
  const unmount = view.unmount.bind(view);
  view.unmount = () => {
    unmount();
    openSessions.delete(session);
    void session.close();
  };
  return { session, port, view, router, settle };
}

/**
 * Opens a block's menu the way a user does: the row carries no button, so the
 * pointer route is a right-click on its bullet.
 */
export async function openBlockMenu(index = 0): Promise<HTMLElement> {
  const bullets = await screen.findAllByTestId("block-bullet");
  fireEvent.contextMenu(bullets[index]);
  return screen.findByRole("menu");
}

/** The page's menu is a right-click on its title row. */
export async function openPageMenu(): Promise<HTMLElement> {
  const title = await screen.findByTestId("page-title");
  fireEvent.contextMenu(title);
  return screen.findByRole("menu");
}

/** A tag's menu is the same gesture on the same kind of row. */
export async function openTagMenu(): Promise<HTMLElement> {
  const title = await screen.findByTestId("tag-title");
  fireEvent.contextMenu(title);
  return screen.findByRole("menu");
}

/** A saved view's menu: right-click the tab it belongs to. */
export async function openViewMenu(name: string): Promise<HTMLElement> {
  const tab = await screen.findByRole("tab", { name });
  fireEvent.contextMenu(tab);
  return screen.findByRole("menu");
}

/**
 * Picks a value from one of the product's dropdowns.
 *
 * Every field-like list of choices uses the same Radix Select, so the route is
 * the same as a user's: press the trigger, then press the option. This replaces
 * `userEvent.selectOptions`, which only ever worked against a native `<select>`.
 */
export async function chooseFromMenu(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement,
  option: string | RegExp,
): Promise<void> {
  await user.click(trigger);
  const choice = await waitFor(() => {
    const row =
      screen.queryByRole("option", { name: option }) ??
      screen.queryByRole("menuitemradio", { name: option });
    if (!row) throw new Error(`Choice not found: ${String(option)}`);
    return row;
  });
  await user.click(choice);
}

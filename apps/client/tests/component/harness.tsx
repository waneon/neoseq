// Component test harness: real GraphSession over the in-memory FakeCorePort,
// mounted inside the app's route shape so router hooks resolve.

import { act, fireEvent, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import type { ReactElement } from "react";
import { GraphSession } from "../../src/core-port/session";
import {
  FakeCorePort,
  openFakeSession,
} from "../../src/core-port/testing/fake-core-port";
import { resetAppSettingsCache } from "../../src/entities/settings";
import { resetQueryDisclosure } from "../../src/features/query/presentation";
import { NotifyProvider } from "../../src/features/notify/context";
import { HistoryProvider } from "../../src/features/history/context";
import { LocaleProvider } from "../../src/i18n";
import { SessionContext } from "../../src/features/shell/session-context";
import { JournalView } from "../../src/features/journal/JournalView";
import { PageView } from "../../src/features/page/PageView";
import { TagsView } from "../../src/features/tags/TagsView";
import { TagView } from "../../src/features/tags/TagView";

export const GRAPH_ID = "test-graph";

export interface Harness {
  session: GraphSession;
  port: FakeCorePort;
  view: RenderResult;
  router: ReturnType<typeof createMemoryRouter>;
}

export async function mountAt(
  initialPath: string,
  custom?: ReactElement,
): Promise<Harness> {
  // App settings and query disclosure are browser-wide and cached, so a test that
  // changed one must not leak it into the next mount.
  resetAppSettingsCache();
  resetQueryDisclosure();
  const { session, port } = await openFakeSession(GRAPH_ID);
  // GraphSession is an external store. Production receives its notifications
  // from Worker promises; component tests must mark that same boundary as a
  // React update instead of forcing every test to wrap domain setup commands.
  const subscribe = session.subscribe;
  session.subscribe = (listener) => subscribe(() => {
    act(listener);
  });
  const router = createMemoryRouter(
    [
      {
        path: "/g/:graphId",
        element: (
          <SessionContext.Provider value={session}>
            <HistoryProvider session={session} graphId={GRAPH_ID}>
              <Outlet />
            </HistoryProvider>
          </SessionContext.Provider>
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
  return { session, port, view, router };
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
    const row = screen.queryByRole("option", { name: option })
      ?? screen.queryByRole("menuitemradio", { name: option });
    if (!row) throw new Error(`Choice not found: ${String(option)}`);
    return row;
  });
  await user.click(choice);
}

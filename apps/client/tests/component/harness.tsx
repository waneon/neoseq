// Component test harness: real GraphSession over the in-memory FakeCorePort,
// mounted inside the app's route shape so router hooks resolve.

import { fireEvent, render, screen, type RenderResult } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import type { ReactElement } from "react";
import { GraphSession } from "../../src/core-port/session";
import {
  FakeCorePort,
  openFakeSession,
} from "../../src/core-port/testing/fake-core-port";
import { resetAppSettingsCache } from "../../src/entities/settings";
import { NotifyProvider } from "../../src/features/notify/context";
import { LocaleProvider } from "../../src/i18n";
import { SessionContext } from "../../src/features/shell/session-context";
import { JournalView } from "../../src/features/journal/JournalView";
import { PageView } from "../../src/features/page/PageView";

export const GRAPH_ID = "test-graph";

export interface Harness {
  session: GraphSession;
  port: FakeCorePort;
  view: RenderResult;
}

export async function mountAt(
  initialPath: string,
  custom?: ReactElement,
): Promise<Harness> {
  // App settings are browser-wide and cached, so a test that changed one must
  // not leak it into the next mount.
  resetAppSettingsCache();
  const { session, port } = await openFakeSession(GRAPH_ID);
  const router = createMemoryRouter(
    [
      {
        path: "/g/:graphId",
        element: (
          <SessionContext.Provider value={session}>
            <Outlet />
          </SessionContext.Provider>
        ),
        children: [
          { path: "journal", element: custom ?? <JournalView /> },
          { path: "journal/:date", element: custom ?? <JournalView /> },
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
  return { session, port, view };
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

/**
 * Picks a value from one of the product's dropdowns.
 *
 * Every list of choices — a language, a journal date format, a property type, a
 * task status — is the same Radix menu the bullet's context menu is
 * (DESIGN.md § Components / Choice), so the route is the same as a user's: press
 * the trigger, then press the option. This replaces `userEvent.selectOptions`,
 * which only ever worked against a native `<select>`.
 */
export async function chooseFromMenu(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement,
  option: string | RegExp,
): Promise<void> {
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitemradio", { name: option }));
}

/** Waits until the session queue settles and React flushed the state. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

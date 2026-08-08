import { createHashRouter, Navigate, RouterProvider } from "react-router";
import { testRoutes } from "virtual:neoseq-test-routes";
import { NotifyProvider } from "../features/notify/context";
import { LocaleProvider } from "../i18n";
import { GraphPicker } from "../features/graphs/GraphPicker";
import { GraphShell } from "../features/shell/GraphShell";
import { JournalView } from "../features/journal/JournalView";
import { PageView } from "../features/page/PageView";

// Hash routing keeps the production bundle deployable on any static file
// server without rewrite rules; page identity is the stable PageId.
const router = createHashRouter([
  { path: "/", element: <GraphPicker /> },
  ...testRoutes,
  {
    path: "/g/:graphId",
    element: <GraphShell />,
    children: [
      { index: true, element: <Navigate to="journal" replace /> },
      { path: "journal", element: <JournalView /> },
      { path: "journal/:date", element: <JournalView /> },
      { path: "p/:pageId", element: <PageView /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

// The notification layer sits above the router: a failure raised while leaving a
// page still has somewhere to land, and the graph picker — which has no shell —
// reports through the same surface as everything else.
export default function App() {
  return (
    <LocaleProvider>
      <NotifyProvider>
        <RouterProvider router={router} />
      </NotifyProvider>
    </LocaleProvider>
  );
}

import { createHashRouter, Navigate, RouterProvider } from "react-router";
import { testRoutes } from "virtual:neoseq-test-routes";
import { GraphPicker } from "../features/graphs/GraphPicker";
import { GraphShell } from "../features/shell/GraphShell";
import { JournalView } from "../features/journal/JournalView";
import { PageView } from "../features/page/PageView";
import { SettingsView } from "../features/settings/SettingsView";

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
      { path: "settings", element: <SettingsView /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}

import { lazy, Suspense } from "react";

const StorageVerificationPage = lazy(async () => {
  const module = await import("../features/verify/StorageVerificationPage");
  return { default: module.StorageVerificationPage };
});

const VisualVerificationPage = lazy(async () => {
  const module = await import("../features/verify/VisualVerificationPage");
  return { default: module.VisualVerificationPage };
});

export const testRoutes = [
  {
    path: "/verify/storage",
    element: (
      <Suspense fallback={null}>
        <StorageVerificationPage />
      </Suspense>
    ),
  },
  {
    path: "/verify/visual",
    element: (
      <Suspense fallback={null}>
        <VisualVerificationPage />
      </Suspense>
    ),
  },
];

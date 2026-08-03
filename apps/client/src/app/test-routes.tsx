import { lazy, Suspense } from "react";

const StorageVerificationPage = lazy(async () => {
  const module = await import("../features/verify/StorageVerificationPage");
  return { default: module.StorageVerificationPage };
});

export const testRoutes = [{
  path: "/verify/storage",
  element: (
    <Suspense fallback={null}>
      <StorageVerificationPage />
    </Suspense>
  ),
}];

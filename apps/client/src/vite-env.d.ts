/// <reference types="vite/client" />

declare module "virtual:neoseq-test-routes" {
  export const testRoutes: import("react-router").RouteObject[];
}

declare module "virtual:neoseq-worker-factory" {
  export function createCoreWorker(): import("./core-worker").CoreWorker;
  export const injectStorageFault:
    | ((worker: import("./core-worker").CoreWorker, graphHandle: string, fault: string) => Promise<void>)
    | undefined;
  export function clearTestHook(): void;
}

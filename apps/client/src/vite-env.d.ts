/// <reference types="vite/client" />

declare const __NEOSEQ_APP_VERSION__: string;
declare const __NEOSEQ_BUILD_ID__: string;

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

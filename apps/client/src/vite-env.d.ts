/// <reference types="vite/client" />

declare module "virtual:neoseq-test-routes" {
  import type { RouteObject } from "react-router";
  export const testRoutes: RouteObject[];
}

declare module "virtual:neoseq-worker-factory" {
  import type { CoreWorker } from "./core-worker";
  export function createCoreWorker(): CoreWorker;
  export function clearTestHook(): void;
  export const injectStorageFault:
    | ((worker: CoreWorker, graphHandle: string, fault: string) => Promise<void>)
    | undefined;
}

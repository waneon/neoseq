/** One asynchronous request: never simultaneously pending and failed. */
export type AsyncRequestState =
  | { status: "idle" }
  | { status: "busy" }
  | { status: "failed"; message: string };

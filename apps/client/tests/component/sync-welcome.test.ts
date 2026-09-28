import { describe, expect, it, vi } from "vitest";
import { applyWelcomePayload } from "../../src/features/sync/SyncAgent";

function target() {
  return {
    applyRemote: vi.fn().mockResolvedValue(undefined),
    replaceRemote: vi.fn().mockResolvedValue(undefined),
  };
}

describe("sync Welcome payloads", () => {
  it("applies a delta without considering checkpoint state", async () => {
    const receiver = target();
    const download = vi.fn();

    await applyWelcomePayload(
      {
        history_epoch: 3,
        server_version_vector: [1],
        payload: { delta: { update: [2, 3] } },
      },
      receiver,
      download,
    );

    expect(receiver.applyRemote).toHaveBeenCalledWith([2, 3]);
    expect(receiver.replaceRemote).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("installs an inline replacement with Welcome metadata", async () => {
    const receiver = target();

    await applyWelcomePayload(
      {
        history_epoch: 4,
        server_version_vector: [5, 6],
        payload: { replace_inline: { checkpoint: [7, 8] } },
      },
      receiver,
      vi.fn(),
    );

    expect(receiver.applyRemote).not.toHaveBeenCalled();
    expect(receiver.replaceRemote).toHaveBeenCalledWith([7, 8], 4, [5, 6]);
  });

  it("uses downloaded version metadata within the same history epoch", async () => {
    const receiver = target();
    const checkpoint = new Uint8Array([9, 10]).buffer;

    await applyWelcomePayload(
      {
        history_epoch: 4,
        server_version_vector: [1],
        payload: { replace_download: {} },
      },
      receiver,
      async () => ({
        checkpoint,
        history_epoch: 4,
        server_version_vector: [11, 12],
      }),
    );

    expect(receiver.applyRemote).not.toHaveBeenCalled();
    expect(receiver.replaceRemote).toHaveBeenCalledWith(checkpoint, 4, [11, 12]);
  });

  it("rejects a missing replacement checkpoint", async () => {
    const receiver = target();
    const download = vi.fn();

    await expect(
      applyWelcomePayload(
        {
          history_epoch: 0,
          server_version_vector: [],
          payload: { replace_inline: { checkpoint: [] } },
        },
        receiver,
        download,
      ),
    ).rejects.toThrow("replacement checkpoint is missing");
  });
});

it("merges bulk catch-up without replacing the replica", async () => {
  const receiver = target();
  const checkpoint = new Uint8Array([1, 2]).buffer;
  await applyWelcomePayload(
    { history_epoch: 2, server_version_vector: [], payload: { merge_download: {} } },
    receiver,
    async () => ({ checkpoint, history_epoch: 2, server_version_vector: [3] }),
  );
  expect(receiver.applyRemote).toHaveBeenCalledWith(checkpoint);
  expect(receiver.replaceRemote).not.toHaveBeenCalled();
});

it("discards a download from a replaced connection", async () => {
  const receiver = target();
  await applyWelcomePayload(
    { history_epoch: 2, server_version_vector: [], payload: { merge_download: {} } },
    receiver,
    async () => ({
      checkpoint: new Uint8Array([1]).buffer,
      history_epoch: 2,
      server_version_vector: [],
    }),
    () => false,
  );
  expect(receiver.applyRemote).not.toHaveBeenCalled();
  expect(receiver.replaceRemote).not.toHaveBeenCalled();
});

it("rejects history changes during a bulk download", async () => {
  const receiver = target();
  await expect(
    applyWelcomePayload(
      { history_epoch: 2, server_version_vector: [], payload: { merge_download: {} } },
      receiver,
      async () => ({
        checkpoint: new Uint8Array([1]).buffer,
        history_epoch: 3,
        server_version_vector: [],
      }),
    ),
  ).rejects.toThrow("checkpoint history changed");
  expect(receiver.applyRemote).not.toHaveBeenCalled();
});

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

  it("uses downloaded checkpoint metadata for a bulk replacement", async () => {
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
        history_epoch: 5,
        server_version_vector: [11, 12],
      }),
    );

    expect(receiver.applyRemote).not.toHaveBeenCalled();
    expect(receiver.replaceRemote).toHaveBeenCalledWith(checkpoint, 5, [11, 12]);
  });

  it("rejects ambiguous or missing replacement states", async () => {
    const receiver = target();
    const download = vi.fn();

    await expect(
      applyWelcomePayload(
        {
          history_epoch: 0,
          server_version_vector: [],
          payload: {
            delta: { update: [] },
            replace_inline: { checkpoint: [1] },
          },
        },
        receiver,
        download,
      ),
    ).rejects.toThrow("welcome payload is invalid");

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

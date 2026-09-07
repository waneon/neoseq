import {
  createRemote,
  expect,
  expectSynced,
  graphId,
  invite,
  openRemote,
  revoke,
  test,
} from "../support/remote";

test("independent browser profiles exchange edits and a fresh replica reads the exact result", async ({
  app: owner,
  remote,
}) => {
  await createRemote(owner, remote, "Shared project");
  await owner.createPage("Project plan");
  await owner.startBlock("Owner draft");
  await owner.appendBlock("Peer draft");
  await invite(owner.page, remote.peer);

  const peer = await remote.newProfile();
  await openRemote(peer, remote, remote.peer, "Shared project", "Project plan");
  await peer.expectOutline(["Owner draft", "Peer draft"]);
  await owner.editBlock(0, "Owner approved");
  await peer.expectOutline(["Owner approved", "Peer draft"]);
  await peer.editBlock(1, "Peer approved");
  await owner.expectOutline(["Owner approved", "Peer approved"]);
  await peer.appendBlock("Ready to publish");
  const expected = ["Owner approved", "Peer approved", "Ready to publish"];
  await owner.expectOutline(expected);
  await peer.expectOutline(expected);
  await expectSynced(owner.page);
  await expectSynced(peer.page);

  const fresh = await remote.newProfile();
  await openRemote(fresh, remote, remote.owner, "Shared project", "Project plan");
  await fresh.expectOutline(expected);
});

test("offline edits survive a reload and merge with the other replica without losing either change", async ({
  app: owner,
  remote,
}) => {
  await createRemote(owner, remote, "Offline project");
  await owner.createPage("Travel plan");
  await owner.startBlock("Owner draft");
  await owner.appendBlock("Peer draft");
  await invite(owner.page, remote.peer);

  const peer = await remote.newProfile();
  await openRemote(peer, remote, remote.peer, "Offline project", "Travel plan");
  await peer.expectOutline(["Owner draft", "Peer draft"]);
  await expectSynced(owner.page);
  await expectSynced(peer.page);
  await peer.offlineReady();
  await peer.page.context().setOffline(true);
  await expect(peer.page.getByTestId("live-status")).toHaveAttribute("data-live", "offline");

  await peer.editBlock(1, "Peer changed offline");
  await expect(peer.page.getByTestId("sync-status")).toHaveAttribute("data-sync", "pending");
  await owner.editBlock(0, "Owner changed online");
  await expectSynced(owner.page);
  await owner.expectOutline(["Owner changed online", "Peer draft"]);

  await peer.page.reload();
  await peer.expectOutline(["Owner draft", "Peer changed offline"]);
  await peer.appendBlock("Added after offline reload");
  await expect(peer.page.getByTestId("save-status")).toHaveAttribute("data-save", "saved");
  await expect(peer.page.getByTestId("sync-status")).toHaveAttribute("data-sync", "pending");

  await peer.page.context().setOffline(false);
  const expected = ["Owner changed online", "Peer changed offline", "Added after offline reload"];
  await peer.expectOutline(expected);
  await owner.expectOutline(expected);
  await expectSynced(peer.page);
  await expectSynced(owner.page);

  const fresh = await remote.newProfile();
  await openRemote(fresh, remote, remote.owner, "Offline project", "Travel plan");
  await fresh.expectOutline(expected);
});

test("revocation preserves the former member's local work while denying it to the server", async ({
  app: owner,
  remote,
}) => {
  await createRemote(owner, remote, "Membership project");
  const id = graphId(owner.page);
  await owner.startBlock("Shared baseline");
  await invite(owner.page, remote.peer);
  const peer = await remote.newProfile();
  await openRemote(peer, remote, remote.peer, "Membership project");
  await peer.expectOutline(["Shared baseline"]);
  await peer.appendBlock("Accepted before revocation");
  await owner.expectOutline(["Shared baseline", "Accepted before revocation"]);
  await expectSynced(peer.page);

  await revoke(owner.page, remote.peer);
  await expect(peer.page.getByTestId("sync-status")).toHaveAttribute("data-sync", "paused");
  await peer.appendBlock("Private after revocation");
  await peer.page.reload();
  await peer.expectOutline([
    "Shared baseline",
    "Accepted before revocation",
    "Private after revocation",
  ]);
  await expect(peer.page.getByTestId("sync-status")).toHaveAttribute("data-sync", "paused");
  expect(await remote.catalog(remote.peer)).toEqual([]);
  expect(await remote.checkpointStatus(remote.peer, id)).toBe(403);

  await owner.appendBlock("Owner continues sharing");
  await expectSynced(owner.page);
  const expected = ["Shared baseline", "Accepted before revocation", "Owner continues sharing"];
  const fresh = await remote.newProfile();
  await openRemote(fresh, remote, remote.owner, "Membership project");
  await fresh.expectOutline(expected);
  await owner.expectOutline(expected);
  await expect(peer.page.getByTestId("sync-status")).toHaveAttribute("data-sync", "paused");
});

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

test("splitting a remote block keeps one visible row per block through local completion", async ({
  app: owner,
  remote,
}) => {
  await createRemote(owner, remote, "Split project");
  await owner.createPage("Split notes");
  await owner.startBlock("headtail");
  await expectSynced(owner.page);
  const input = owner.editors.first();
  await input.click();
  await input.press("Home");
  await input.press("ArrowRight");
  await input.press("ArrowRight");
  await input.press("ArrowRight");
  await input.press("ArrowRight");
  await owner.page.evaluate(() => {
    const capture = { counts: [] as number[], frame: 0 };
    Object.assign(window, { splitCapture: capture });
    const sample = () => {
      capture.counts.push(document.querySelectorAll('[data-testid="outline-row"]').length);
      capture.frame = requestAnimationFrame(sample);
    };
    sample();
  });
  await owner.saved(() => input.press("Enter"));
  await owner.expectOutline(["head", "tail"]);
  await expect(owner.editors.last()).toBeFocused();
  await expect(owner.page.locator('[data-block-id^="pending-"]')).toHaveCount(0);
  await expectSynced(owner.page);
  const counts = await owner.page.evaluate(() => {
    const capture = (window as unknown as { splitCapture: { counts: number[]; frame: number } })
      .splitCapture;
    cancelAnimationFrame(capture.frame);
    return capture.counts;
  });
  expect(counts.length).toBeGreaterThan(1);
  expect(counts.every((count) => count === 1 || count === 2)).toBe(true);

  await owner.editBlock(1, "tail continues");
  await expectSynced(owner.page);
  const fresh = await remote.newProfile();
  await openRemote(fresh, remote, remote.owner, "Split project", "Split notes");
  await fresh.expectOutline(["head", "tail continues"]);
});

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

test("reconnecting during native Hangul composition merges a change to the same block", async ({
  app: owner,
  remote,
}) => {
  await createRemote(owner, remote, "Composition reconnect");
  await owner.createPage("Writing");
  await owner.startBlock("abcdef");
  await invite(owner.page, remote.peer);
  await expectSynced(owner.page);
  const peer = await remote.newProfile();
  await openRemote(peer, remote, remote.peer, "Composition reconnect", "Writing");
  await peer.expectOutline(["abcdef"]);
  await expectSynced(peer.page);
  await peer.page.context().setOffline(true);
  await expect(peer.page.getByTestId("live-status")).toHaveAttribute("data-live", "offline");
  const input = peer.editors.first();
  await input.click();
  await input.press("Home");
  for (let i = 0; i < 3; i++) await input.press("ArrowRight");
  const ime = await peer.page.context().newCDPSession(peer.page);
  await ime.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 });
  await expect(input).toHaveValue("abc한def");
  await owner.editBlock(0, "aXbcdef");
  await expectSynced(owner.page);
  await peer.page.context().setOffline(false);
  await expect(peer.page.getByTestId("live-status")).toHaveAttribute("data-live", "live");
  await expect(input).toHaveValue("abc한def");
  await peer.saved(() => ime.send("Input.insertText", { text: "한" }));
  await expect(input).toHaveValue("aXbc한def");
  await expect
    .poll(() => input.evaluate((node) => (node as HTMLTextAreaElement).selectionStart))
    .toBe(5);
  await peer.saved(async () => {
    await ime.send("Input.insertText", { text: "글" });
    await input.blur();
  });
  await owner.expectOutline(["aXbc한글def"]);
  await peer.expectOutline(["aXbc한글def"]);
  await expectSynced(peer.page);
  await ime.detach();
});

test("checkpoint compaction keeps the active editor and WebSocket alive", async ({
  app,
  remote,
}) => {
  const edits = remote.checkpointTailUpdates + 4;
  let connections = 0;
  let closes = 0;
  app.page.on("websocket", (socket) => {
    connections++;
    socket.on("close", () => {
      closes++;
    });
  });
  await createRemote(app, remote, "Checkpoint writing");
  await app.createPage("Writing");
  await app.startBlock("Start");
  await expectSynced(app.page);
  const initialConnections = connections;
  const initialCloses = closes;
  for (let index = 0; index < edits; index++) await app.editBlock(0, `Revision ${index}`);
  await expectSynced(app.page);
  expect(connections).toBe(initialConnections);
  expect(closes).toBe(initialCloses);
  await app.appendBlock("Continued after compaction");
  await expectSynced(app.page);
  const fresh = await remote.newProfile();
  await openRemote(fresh, remote, remote.owner, "Checkpoint writing", "Writing");
  await fresh.expectOutline([`Revision ${edits - 1}`, "Continued after compaction"]);
});

test("document conversion merges offline edits and preserves identity on both replicas", async ({
  app: owner,
  remote,
}) => {
  await createRemote(owner, remote, "Conversion project");
  await owner.createPage("env");
  await owner.startBlock("Environment notes");
  const pageURL = owner.page.url();
  const blockId = await owner.block(0).getAttribute("data-block-id");
  await invite(owner.page, remote.peer);
  const peer = await remote.newProfile();
  await openRemote(peer, remote, remote.peer, "Conversion project", "env");
  await peer.expectOutline(["Environment notes"]);
  await expectSynced(peer.page);
  await peer.page.context().setOffline(true);
  await peer.editBlock(0, "Environment notes edited offline");

  await owner.page.getByTestId("page-actions-trigger").click();
  await owner.saved(() => owner.page.getByTestId("convert-to-tag").click());
  await expect(owner.page.getByTestId("tag-title")).toHaveValue("env");
  await expectSynced(owner.page);
  await peer.page.context().setOffline(false);
  await expect(peer.page.getByTestId("tag-title")).toHaveValue("env");
  await owner.expectOutline(["Environment notes edited offline"]);
  await peer.expectOutline(["Environment notes edited offline"]);
  expect(await peer.block(0).getAttribute("data-block-id")).toBe(blockId);
  await expectSynced(peer.page);

  await peer.page.getByTestId("tag-actions-trigger").click();
  await peer.saved(() => peer.page.getByTestId("convert-to-page").click());
  await expect(owner.page).toHaveURL(pageURL);
  await owner.expectOutline(["Environment notes edited offline"]);
  await expectSynced(peer.page);
  await expectSynced(owner.page);
  const fresh = await remote.newProfile();
  await openRemote(fresh, remote, remote.owner, "Conversion project", "env");
  await fresh.expectOutline(["Environment notes edited offline"]);
  expect(await fresh.block(0).getAttribute("data-block-id")).toBe(blockId);
});

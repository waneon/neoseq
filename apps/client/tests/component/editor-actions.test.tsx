import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { findPage, queryDocument, stringValue } from "../../src/core-port/snapshot";
import { TASK_STATUS_KEY } from "../../src/entities/tasks";
import { GRAPH_ID, mountAt, openBlockMenu, openPageMenu } from "./harness";

async function mountBlock() {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "Write",
    });
  });
  await screen.findByLabelText("Block text");
  const page = () => findPage(harness.session.getState().snapshot, "home")!;
  return { ...harness, page };
}

describe("contextual writing actions", () => {
  it.each(["page", "block"] as const)("creates a %s query from Add property", async (kind) => {
    const harness = await mountBlock();
    if (kind === "page") {
      await openPageMenu();
      await harness.settle(() => {
        fireEvent.click(screen.getByTestId("menu-page-properties"));
      });
    } else {
      await openBlockMenu();
      await harness.settle(() => {
        fireEvent.click(screen.getByTestId("menu-properties"));
      });
    }
    const picker = await screen.findByTestId("property-picker");
    await harness.settle(() => {
      fireEvent.change(within(picker).getByRole("searchbox"), { target: { value: "query" } });
    });
    await harness.settle(async () => {
      fireEvent.click(within(picker).getByRole("option", { name: "Query", exact: true }));
      await harness.session.executePrepared(() => null);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await waitFor(() => {
      const bag = kind === "page" ? harness.page().properties : harness.page().blocks[0].properties;
      expect(queryDocument(bag)?.views[0].definition.plan).toBeTruthy();
      expect(screen.queryByTestId("property-picker")).not.toBeInTheDocument();
      expect(screen.getByTestId("query-block")).toBeInTheDocument();
    });
  });

  it("cycles tasks with Command or Control Enter and includes the draft in one undo", async () => {
    const harness = await mountBlock();
    const user = userEvent.setup();
    const input = screen.getByLabelText("Block text");
    await user.click(input);
    const changeStatus = async (gesture: () => void, status: string | undefined) => {
      await harness.settle(async () => {
        const revision = harness.session.getState().canonicalRevision;
        const published = new Promise<void>((resolve) => {
          const unsubscribe = harness.session.subscribe(() => {
            if (
              harness.session.getState().canonicalRevision > revision &&
              stringValue(harness.page().blocks[0].properties, TASK_STATUS_KEY) === status
            ) {
              unsubscribe();
              resolve();
            }
          });
        });
        gesture();
        await published;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
    };
    await changeStatus(() => {
      fireEvent.change(input, { target: { value: "Write now" } });
      fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    }, "todo");
    expect(harness.page().blocks[0].markdown).toBe("Write now");
    await changeStatus(() => {
      fireEvent.keyDown(input, { key: "z", metaKey: true });
    }, undefined);
    expect(input).toHaveValue("Write");
    for (const status of ["todo", "doing", "done", undefined, "todo"]) {
      await changeStatus(() => {
        fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
      }, status);
      expect(harness.page().blocks).toHaveLength(1);
      expect(input).toHaveFocus();
    }
  });

  it("leaves composing input untouched by the task shortcut", async () => {
    const harness = await mountBlock();
    const input = screen.getByLabelText("Block text");
    await harness.settle(() => {
      fireEvent.compositionStart(input);
      fireEvent.keyDown(input, { key: "Enter", metaKey: true, isComposing: true });
      fireEvent.compositionEnd(input);
    });
    expect(stringValue(harness.page().blocks[0].properties, TASK_STATUS_KEY)).toBeUndefined();
    expect(harness.page().blocks).toHaveLength(1);
  });

  it("carries repeated task shortcuts across pending block creation", async () => {
    const harness = await mountBlock();
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    harness.port.beforeExecute = async (command) => {
      if (command.type !== "split_block") return;
      entered();
      await gate;
    };
    const input = screen.getByLabelText("Block text") as HTMLTextAreaElement;
    await user.click(input);
    input.setSelectionRange(input.value.length, input.value.length);
    await user.keyboard("{Enter}");
    await started;
    await user.keyboard("{Meta>}{Enter}{Enter}{/Meta}");
    await harness.settle(async () => {
      release();
      await harness.session.executePrepared(() => null);
    });
    await waitFor(() => {
      expect(harness.page().blocks).toHaveLength(2);
      expect(stringValue(harness.page().blocks[1].properties, TASK_STATUS_KEY)).toBe("doing");
    });
  });

  it("offers separate tag navigation and removal, with undo restoring membership", async () => {
    const harness = await mountBlock();
    await harness.settle(async () => {
      await harness.session.execute({ type: "ensure_tag", tag_id: "project", name: "Project" });
      await harness.session.execute({
        type: "add_tag",
        entity: {
          kind: "block",
          owner: { kind: "page", id: "home" },
          id: harness.page().blocks[0].id,
        },
        tag_id: "project",
      });
    });
    expect(screen.getByRole("link", { name: "Tags on this block: Project" })).toHaveAttribute(
      "href",
      expect.stringContaining("/t/project"),
    );
    await harness.settle(() => {
      fireEvent.click(screen.getByRole("button", { name: "Remove tag Project" }));
    });
    await waitFor(() => expect(harness.page().blocks[0].tags).toEqual([]));
    expect(screen.queryByTestId("tag-chip")).not.toBeInTheDocument();
    await act(async () => {
      await harness.session.execute({ type: "undo" });
    });
    await waitFor(() => expect(harness.page().blocks[0].tags).toEqual(["project"]));
  });
});

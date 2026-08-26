import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_DUE_TIERS } from "../../src/entities/settings";
import { vimModeForActivation } from "../../src/features/blocks/editor/activation";
import { BLOCK_SURFACE_POLICY } from "../../src/features/blocks/editor/surface-policy";
import { TaskMoment } from "../../src/features/tasks/TaskMoment";
import {
  taskMomentDue,
  type TaskMomentPresentation,
} from "../../src/features/tasks/moment-presentation";

describe("block surface contracts", () => {
  it("derives modal entry from activation intent, independent of the host", () => {
    expect(vimModeForActivation("vim", false, "pointer")).toBe("insert");
    expect(vimModeForActivation("vim", false, "context_menu")).toBe("insert");
    expect(vimModeForActivation("vim", false, "keyboard")).toBeNull();
    expect(vimModeForActivation("standard", false, "pointer")).toBeNull();
    expect(vimModeForActivation("vim", true, "pointer")).toBeNull();
  });

  it("keeps only deliberate host differences in the surface policy", () => {
    expect(BLOCK_SURFACE_POLICY).toEqual({
      outline: {
        markdown: "block",
        enter: "split",
        structure: true,
        visualLine: true,
        crossBlockWords: true,
      },
      queryList: {
        markdown: "block",
        enter: "commit",
        structure: false,
        visualLine: false,
        crossBlockWords: false,
      },
      queryTable: {
        markdown: "compact",
        enter: "commit",
        structure: false,
        visualLine: false,
        crossBlockWords: false,
      },
    });
  });

  it("projects one moment meaning through chip and cell appearances", () => {
    const value: TaskMomentPresentation = {
      kind: "scheduled",
      label: "Scheduled",
      dateLabel: "August 26",
      timeLabel: "14:30",
      due: { tier: "soon", tone: "caution" },
      repeating: true,
      title: "August 26 · 14:30",
    };

    const { container } = render(
      <>
        <TaskMoment value={value} appearance="chip" />
        <TaskMoment value={value} appearance="cell" />
      </>,
    );

    const projections = container.querySelectorAll('[data-task-moment="scheduled"]');
    expect(projections).toHaveLength(2);
    for (const projection of projections) {
      expect(projection).toHaveAttribute("data-due", "soon");
      expect(projection).toHaveAttribute("data-palette", "caution");
      expect(projection).toHaveTextContent("August 26");
      expect(projection).toHaveTextContent("14:30");
    }
    expect(container.querySelectorAll(".task-moment-value")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Scheduled August 26 14:30/ }))
      .toBeInTheDocument();
    expect(container.querySelector(".query-due")).toHaveAttribute(
      "title",
      "August 26 · 14:30",
    );
  });

  it("removes urgency from settled moments before any surface sees them", () => {
    expect(taskMomentDue({
      date: "2026-08-26",
      settled: true,
      today: "2026-08-26",
      now: "12:00",
      tiers: DEFAULT_DUE_TIERS,
    })).toBeNull();
  });
});

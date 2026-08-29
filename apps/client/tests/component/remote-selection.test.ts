import { transformSelection } from "../../src/features/outline/selection-transform";

describe("remote selection transform", () => {
  it("moves a caret after a remote insertion", () => {
    expect(
      transformSelection("hello world", "hello brave world", { anchor: 11, head: 11 }),
    ).toEqual({ anchor: 17, head: 17 });
  });

  it("keeps direction while a selected range is replaced remotely", () => {
    expect(transformSelection("one two three", "one 2 three", { anchor: 11, head: 4 })).toEqual({
      anchor: 9,
      head: 4,
    });
  });
});

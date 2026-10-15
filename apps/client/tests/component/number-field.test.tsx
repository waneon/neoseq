// A number field keeps partial input on screen and reports only real numbers.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it } from "vitest";
import { NumberField } from "../../src/ui/NumberField";

function Field({ start, seen }: { start: number; seen: number[] }) {
  const [value, setValue] = useState(start);
  return (
    <NumberField
      aria-label="amount"
      value={value}
      valid={(next) => Number.isInteger(next)}
      onValue={(next) => {
        seen.push(next);
        setValue(next);
      }}
    />
  );
}

it("takes a negative number and a cleared field without inventing zero", async () => {
  const seen: number[] = [];
  render(<Field start={7} seen={seen} />);
  const field = screen.getByLabelText("amount");
  const user = userEvent.setup();
  await user.clear(field);
  expect(field).toHaveValue(null);
  await user.type(field, "-5");
  expect(field).toHaveValue(-5);
  expect(seen).toEqual([-5]);
  await user.clear(field);
  await user.type(field, "50");
  expect(seen).toEqual([-5, 5, 50]);
  await user.tab();
  expect(field).toHaveValue(50);
});

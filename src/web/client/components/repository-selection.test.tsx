// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import {
  RepositorySelectionProvider,
  useRepositorySelection,
} from "./repository-selection.js";

afterEach(cleanup);

function SelectionProbe() {
  const selection = useRepositorySelection();
  return (
    <>
      <output aria-label="Selected record">{selection.recordId ?? "none"}</output>
      <output aria-label="Selected repository node">{selection.nodeId ?? "none"}</output>
      <button type="button" onClick={() => selection.selectRecord("task-one")}>
        Select record
      </button>
      <button type="button" onClick={() => selection.selectRepositoryNode("node-readme")}>
        Select repository node
      </button>
      <button type="button" onClick={selection.clearSelection}>Clear</button>
    </>
  );
}

test("coordinates one bounded record-or-repository selection without treating it as authority", async () => {
  const user = userEvent.setup();
  render(<RepositorySelectionProvider><SelectionProbe /></RepositorySelectionProvider>);

  await user.click(screen.getByRole("button", { name: "Select record" }));
  expect(screen.getByLabelText("Selected record").textContent).toBe("task-one");
  expect(screen.getByLabelText("Selected repository node").textContent).toBe("none");

  await user.click(screen.getByRole("button", { name: "Select repository node" }));
  expect(screen.getByLabelText("Selected record").textContent).toBe("none");
  expect(screen.getByLabelText("Selected repository node").textContent).toBe("node-readme");

  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(screen.getByLabelText("Selected repository node").textContent).toBe("none");
});

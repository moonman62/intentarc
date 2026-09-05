// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import {
  boundedPreview,
  boundedUnicodePreview,
  RecordPreview,
} from "./record-preview.js";

afterEach(cleanup);

test("bounds repeated related-record detail to a single calm preview", () => {
  const body = "Retrieve this governed detail separately. ".repeat(2_000);

  render(
    <RecordPreview
      title="Evidence"
      kind="evidence"
      body={body}
      href="/records/evidence-1"
    />,
  );

  expect(screen.getByText("Evidence")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open record" })).toBeTruthy();
  expect(document.body.textContent!.length).toBeLessThan(1_200);
  expect(document.body.textContent!.match(
    /Retrieve this governed detail separately\./g,
  )?.length).toBe(1);
});

test("keeps the original oversized record body out of rendered markup", () => {
  const body = `PRIVATE-RECORD-BODY-SENTINEL ${"governed detail ".repeat(80)}`;
  const bounded = `${body.slice(0, 420).trimEnd()}…`;

  const { container } = render(
    <RecordPreview
      title="Evidence"
      kind="evidence"
      body={body}
      href="/records/evidence-1"
    />,
  );

  expect(container.innerHTML).toContain(bounded);
  expect(container.innerHTML).not.toContain(body);
});

test("uses a custom link label without changing the record preview", () => {
  render(
    <RecordPreview
      title="Evidence"
      kind="evidence"
      body="Reviewed evidence."
      href="/projects/project-1/map?focusRecordId=task-1"
      linkLabel="Open related task"
    />,
  );

  const link = screen.getByRole("link", { name: "Open related task" });
  expect(link.getAttribute("href")).toBe("/projects/project-1/map?focusRecordId=task-1");
  expect(screen.queryByRole("link", { name: "Open record" })).toBeNull();
  expect(screen.getByText("Reviewed evidence.")).toBeTruthy();
});

test("bounds previews by Unicode code point without leaking the omitted tail", () => {
  const value = `${"😀".repeat(8)}TAIL-SENTINEL`;

  const preview = boundedPreview(value, 6);

  expect(preview).toBe(`${"😀".repeat(6)}…`);
  expect(Array.from(preview)).toHaveLength(7);
  expect(preview).not.toContain("TAIL-SENTINEL");
});

test("bounds exact document text without rewriting leading accepted content", () => {
  const value = `  accepted indentation\n${"😀".repeat(5)}TAIL-SENTINEL`;

  const preview = boundedUnicodePreview(value, 25);

  expect(preview.startsWith("  accepted indentation\n")).toBe(true);
  expect(preview).toMatch(/…$/);
  expect(preview).not.toContain("TAIL-SENTINEL");
});

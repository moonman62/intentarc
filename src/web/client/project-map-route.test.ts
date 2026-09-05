import { describe, expect, test } from "vitest";
import { parseProjectMapRoute, projectMapPath } from "./project-map-route.js";

describe("Project Map client routes", () => {
  test("preserves a scope-only selection when serializing a client route", () => {
    expect(projectMapPath("project-1", {
      focusRecordId: null,
      scopeRecordId: "feature-1",
    })).toBe("/projects/project-1/map?scopeRecordId=feature-1");
  });

  test("parses a scope-only client route without requiring a server query selection", () => {
    expect(parseProjectMapRoute(
      "/projects/project-1/map",
      "/projects/project-1/map?scopeRecordId=feature-1",
    )).toEqual({
      projectId: "project-1",
      focusRecordId: null,
      scopeRecordId: "feature-1",
    });
  });

  test.each([
    "?focusRecordId=a&focusRecordId=b",
    "?scopeRecordId=a&scopeRecordId=b",
    "?unknown=x",
    "?focusRecordId=",
  ])("rejects an invalid client map query: %s", (query) => {
    expect(parseProjectMapRoute(
      "/projects/project-1/map",
      `/projects/project-1/map${query}`,
    )).toBeNull();
  });
});

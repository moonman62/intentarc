// @vitest-environment jsdom

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  loadPreference,
  preferenceKeys,
  savePreference,
} from "./preferences.js";

afterEach(cleanup);

describe("preferences", () => {
  beforeEach(() => localStorage.clear());

  test("returns only values accepted by the preference", () => {
    localStorage.setItem(preferenceKeys.sidebar, "wide");

    expect(
      loadPreference(preferenceKeys.sidebar, ["expanded", "collapsed"]),
    ).toBeNull();

    localStorage.setItem(preferenceKeys.sidebar, "collapsed");
    expect(
      loadPreference(preferenceKeys.sidebar, ["expanded", "collapsed"]),
    ).toBe("collapsed");
  });

  test("saves and clears a preference", () => {
    savePreference(preferenceKeys.activeProject, "project-one");
    expect(localStorage.getItem("intentarc.activeProject")).toBe("project-one");

    savePreference(preferenceKeys.activeProject, null);
    expect(localStorage.getItem("intentarc.activeProject")).toBeNull();
  });
});

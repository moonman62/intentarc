import { describe, expect, it } from "vitest";
import { formatVersion } from "./version.js";

describe("formatVersion", () => {
  it("returns the product and package version shown by CLI clients", () => {
    expect(formatVersion("1.2.3")).toBe("intentarc 1.2.3");
  });
});

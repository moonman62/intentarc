// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ThemeToggle } from "./theme-toggle.js";

afterEach(cleanup);

const installColorScheme = (
  dark: boolean,
): ((nextDark: boolean) => void) => {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" && dark,
      media: query,
      onchange: null,
      addEventListener: (
        event: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        if (event === "change") listeners.add(listener);
      },
      removeEventListener: (
        event: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        if (event === "change") listeners.delete(listener);
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  return (nextDark: boolean) => {
    for (const listener of listeners) {
      listener({ matches: nextDark } as MediaQueryListEvent);
    }
  };
};

describe("ThemeToggle", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    installColorScheme(false);
  });

  test("saves a dark theme override when the user requests it", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole("button", { name: "Use dark theme" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("intentarc.theme")).toBe("dark");
  });

  test("uses the OS theme when no override has been saved", () => {
    installColorScheme(true);

    render(<ThemeToggle />);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("intentarc.theme")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Use light theme" }),
    ).toBeTruthy();
  });

  test("ignores an invalid saved theme", () => {
    localStorage.setItem("intentarc.theme", "sepia");

    render(<ThemeToggle />);

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(
      screen.getByRole("button", { name: "Use dark theme" }),
    ).toBeTruthy();
  });

  test("keeps multiple mounted theme controls synchronized", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ThemeToggle />
        <ThemeToggle />
      </>,
    );

    await user.click(
      screen.getAllByRole("button", { name: "Use dark theme" })[0]!,
    );

    expect(
      screen.getAllByRole("button", { name: "Use light theme" }),
    ).toHaveLength(2);
  });

  test("keeps a manual override when the OS theme later changes", async () => {
    const emitColorScheme = installColorScheme(false);
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole("button", { name: "Use dark theme" }));
    act(() => emitColorScheme(false));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("intentarc.theme")).toBe("dark");
    expect(
      screen.getByRole("button", { name: "Use light theme" }),
    ).toBeTruthy();
  });
});

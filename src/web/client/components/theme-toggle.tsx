import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import {
  loadPreference,
  preferenceKeys,
  savePreference,
  type ThemePreference,
} from "../preferences.js";

const themeValues = ["light", "dark"] as const;
const themeQuery = "(prefers-color-scheme: dark)";
const themeChangeEvent = "intentarc:theme-change";

const getSystemTheme = (): ThemePreference =>
  window.matchMedia(themeQuery).matches ? "dark" : "light";

const getInitialTheme = (): ThemePreference =>
  loadPreference(preferenceKeys.theme, themeValues) ?? getSystemTheme();

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemePreference>(getInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const followOverride = (event: Event) => {
      setTheme((event as CustomEvent<ThemePreference>).detail);
    };
    window.addEventListener(themeChangeEvent, followOverride);
    return () => window.removeEventListener(themeChangeEvent, followOverride);
  }, []);

  useEffect(() => {
    if (loadPreference(preferenceKeys.theme, themeValues)) return;
    const media = window.matchMedia(themeQuery);
    const followSystem = (event: MediaQueryListEvent) => {
      if (loadPreference(preferenceKeys.theme, themeValues)) return;
      setTheme(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", followSystem);
    return () => media.removeEventListener("change", followSystem);
  }, []);

  const nextTheme: ThemePreference = theme === "dark" ? "light" : "dark";
  const Icon = theme === "dark" ? Sun : Moon;

  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={`Use ${nextTheme} theme`}
      title={`Use ${nextTheme} theme`}
      onClick={() => {
        savePreference(preferenceKeys.theme, nextTheme);
        window.dispatchEvent(
          new CustomEvent<ThemePreference>(
            themeChangeEvent,
            { detail: nextTheme },
          ),
        );
      }}
    >
      <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
      <span className="theme-toggle__label">
        {theme === "dark" ? "Light mode" : "Dark mode"}
      </span>
    </button>
  );
}

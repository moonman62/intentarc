export const preferenceKeys = {
  theme: "intentarc.theme",
  sidebar: "intentarc.sidebar",
  activeProject: "intentarc.activeProject",
  preferredProfilePrefix: "intentarc.preferredProfile.",
} as const;

export type ThemePreference = "light" | "dark";
export type SidebarPreference = "expanded" | "collapsed";

export function loadPreference<const Value extends string>(
  key: string,
  validValues?: readonly Value[],
): Value | null {
  const value = localStorage.getItem(key);
  if (value === null) return null;
  if (validValues && !validValues.includes(value as Value)) return null;
  return value as Value;
}

export function savePreference(key: string, value: string | null): void {
  if (value === null) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, value);
}

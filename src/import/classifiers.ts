import type { RecordStatus } from "../domain/model.js";
import type { DiscoveredRepository } from "./discovery-model.js";

const compareOrdinal = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

export interface GodotFacts {
  readonly projectName: string | null;
  readonly engineFeatures: readonly string[];
  readonly mainScene: string | null;
  readonly autoloads: readonly string[];
}

export interface ClassifiedComponent {
  readonly key: string;
  readonly title: string;
  readonly status: Extract<RecordStatus, "accepted" | "archived">;
  readonly sourceRefs: readonly string[];
}

export interface ClassifiedRepository {
  readonly godot: GodotFacts | null;
  readonly components: readonly ClassifiedComponent[];
  readonly supportingDocuments: readonly string[];
}

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1)
      .replaceAll("\\\"", "\"")
      .replaceAll("\\\\", "\\");
  }
  return trimmed;
};

const readIni = (text: string): ReadonlyMap<string, ReadonlyMap<string, string>> => {
  const sections = new Map<string, Map<string, string>>();
  let currentSection: Map<string, string> | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(";") || line.startsWith("#")) continue;

    const sectionMatch = /^\[([^\]\r\n]+)\]$/.exec(line);
    if (sectionMatch !== null) {
      const sectionName = sectionMatch[1]!.trim();
      currentSection = sections.get(sectionName) ?? new Map<string, string>();
      sections.set(sectionName, currentSection);
      continue;
    }

    if (currentSection === null) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!currentSection.has(key)) {
      currentSection.set(key, line.slice(separator + 1).trim());
    }
  }

  return sections;
};

const parsePackedStrings = (value: string | undefined): string[] => {
  if (value === undefined) return [];
  const match = /^PackedStringArray\((.*)\)$/.exec(value.trim());
  if (match === null) return [];
  const values: string[] = [];
  const quoted = /"((?:\\.|[^"\\])*)"/g;
  let item: RegExpExecArray | null;
  while ((item = quoted.exec(match[1]!)) !== null) {
    values.push(item[1]!.replaceAll("\\\"", "\"").replaceAll("\\\\", "\\"));
  }
  return values;
};

const godotFacts = (discovery: DiscoveredRepository): GodotFacts | null => {
  const expectedPath = discovery.repository.canonicalSubpath === null
    ? "project.godot"
    : `${normalizePath(discovery.repository.canonicalSubpath)}/project.godot`;
  const project = discovery.selectedSources.find(
    (source) => normalizePath(source.path) === expectedPath,
  );
  if (project === undefined) return null;

  const sections = readIni(project.text);
  const application = sections.get("application");
  const autoload = sections.get("autoload");

  return {
    projectName: application?.get("config/name") === undefined
      ? null
      : unquote(application.get("config/name")!),
    engineFeatures: parsePackedStrings(application?.get("config/features")),
    mainScene: application?.get("run/main_scene") === undefined
      ? null
      : unquote(application.get("run/main_scene")!),
    autoloads: [...(autoload?.keys() ?? [])].sort(compareOrdinal),
  };
};

interface MutableComponent {
  readonly key: string;
  readonly title: string;
  readonly status: ClassifiedComponent["status"];
  readonly sourceRefs: Set<string>;
}

const componentDefinitions = {
  core: { key: "component.core", title: "Runtime core" },
  content: { key: "component.content", title: "Content" },
  ui: { key: "component.ui", title: "UI" },
  tests: { key: "component.tests", title: "Tests" },
  assets: { key: "component.assets", title: "Assets" },
  tools: { key: "component.tools", title: "Tools" },
} as const;

type ComponentDirectory = keyof typeof componentDefinitions;

const isWithinCanonical = (
  path: string,
  canonicalSubpath: string | null,
): boolean => {
  if (canonicalSubpath === null) return true;
  const normalized = normalizePath(path);
  const canonical = normalizePath(canonicalSubpath);
  return normalized === canonical || normalized.startsWith(`${canonical}/`);
};

const canonicalComponentDirectory = (
  path: string,
  canonicalSubpath: string | null,
): ComponentDirectory | null => {
  const normalized = normalizePath(path);
  const relativePath = canonicalSubpath === null
    ? normalized
    : normalized.startsWith(`${normalizePath(canonicalSubpath)}/`)
      ? normalized.slice(normalizePath(canonicalSubpath).length + 1)
      : null;
  if (relativePath === null) return null;

  const segments = relativePath.toLowerCase().split("/");
  if (segments[0] === "src" && (
    segments[1] === "core" ||
    segments[1] === "content" ||
    segments[1] === "ui"
  )) {
    return segments[1];
  }
  if (segments.includes("tests") || segments.includes("test")) return "tests";
  if (segments.includes("tools") || segments.includes("tool")) return "tools";
  if (segments.includes("assets") || segments.includes("asset")) return "assets";
  return null;
};

const classifyComponents = (
  discovery: DiscoveredRepository,
): ClassifiedComponent[] => {
  const components = new Map<string, MutableComponent>();
  const add = (
    definition: { readonly key: string; readonly title: string },
    status: ClassifiedComponent["status"],
    sourceRef: string,
  ): void => {
    const component = components.get(definition.key) ?? {
      ...definition,
      status,
      sourceRefs: new Set<string>(),
    };
    component.sourceRefs.add(normalizePath(sourceRef));
    components.set(definition.key, component);
  };

  for (const source of discovery.selectedSources) {
    if (
      source.role !== "supporting_document" &&
      !isWithinCanonical(source.path, discovery.repository.canonicalSubpath)
    ) {
      add(
        { key: "component.archived-prototype", title: "Archived prototype" },
        "archived",
        source.path,
      );
      continue;
    }
    const directory = canonicalComponentDirectory(
      source.path,
      discovery.repository.canonicalSubpath,
    );
    if (directory !== null) add(componentDefinitions[directory], "accepted", source.path);
  }

  for (const collection of discovery.discovery.binaryCollections) {
    if (!isWithinCanonical(
      collection.directory,
      discovery.repository.canonicalSubpath,
    )) {
      add(
        { key: "component.archived-prototype", title: "Archived prototype" },
        "archived",
        collection.directory || ".",
      );
      continue;
    }
    const directory = canonicalComponentDirectory(
      `${collection.directory}/collection`,
      discovery.repository.canonicalSubpath,
    );
    if (directory !== null) {
      add(
        componentDefinitions[directory],
        "accepted",
        collection.directory || ".",
      );
    }
  }

  return [...components.values()]
    .map((component) => ({
      key: component.key,
      title: component.title,
      status: component.status,
      sourceRefs: [...component.sourceRefs].sort(compareOrdinal),
    }))
    .sort((left, right) => compareOrdinal(left.key, right.key));
};

export const classifyRepository = (
  discovery: DiscoveredRepository,
): ClassifiedRepository => ({
  godot: godotFacts(discovery),
  components: classifyComponents(discovery),
  supportingDocuments: discovery.selectedSources
    .filter((source) => source.role === "supporting_document")
    .map((source) => normalizePath(source.path))
    .sort(compareOrdinal),
});

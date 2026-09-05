import { mapIdentifierSchema } from "../contracts.js";

const mapRoutePattern = /^\/projects\/([^/]+)\/map\/?$/;

export interface ProjectMapRouteState {
  readonly projectId: string;
  readonly focusRecordId: string | null;
  readonly scopeRecordId: string | null;
}

export function projectMapPath(
  projectId: string,
  selection: Pick<ProjectMapRouteState, "focusRecordId" | "scopeRecordId">,
): string {
  const path = `/projects/${encodeURIComponent(projectId)}/map`;
  const query = new URLSearchParams();
  if (selection.focusRecordId !== null) query.set("focusRecordId", selection.focusRecordId);
  if (selection.scopeRecordId !== null) query.set("scopeRecordId", selection.scopeRecordId);
  const encoded = query.toString();
  return encoded === "" ? path : `${path}?${encoded}`;
}

export function parseProjectMapRoute(
  route: string,
  locationRoute: string,
): ProjectMapRouteState | null {
  const encodedId = mapRoutePattern.exec(route)?.[1];
  if (encodedId === undefined) return null;

  try {
    const query = locationRoute.includes("?")
      ? locationRoute.slice(locationRoute.indexOf("?") + 1)
      : "";
    const params = new URLSearchParams(query);
    const allowed = new Set(["focusRecordId", "scopeRecordId"]);
    if ([...params.keys()].some((key) => !allowed.has(key))) return null;

    const focusValues = params.getAll("focusRecordId");
    const scopeValues = params.getAll("scopeRecordId");
    if (focusValues.length > 1 || scopeValues.length > 1) return null;

    const parsedFocus = focusValues[0] === undefined
      ? null
      : mapIdentifierSchema.safeParse(focusValues[0]);
    const parsedScope = scopeValues[0] === undefined
      ? null
      : mapIdentifierSchema.safeParse(scopeValues[0]);
    if (parsedFocus !== null && !parsedFocus.success) return null;
    if (parsedScope !== null && !parsedScope.success) return null;

    return {
      projectId: decodeURIComponent(encodedId),
      focusRecordId: parsedFocus === null ? null : parsedFocus.data,
      scopeRecordId: parsedScope === null ? null : parsedScope.data,
    };
  } catch {
    return null;
  }
}

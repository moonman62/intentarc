import {
  RepositoryRefreshInProgressError,
  RepositoryRefreshSelectionError,
  RepositoryRefreshUnavailableError,
} from "../../core/repository-refresh-service.js";
import { RepositoryObservationDriftError } from "../../repository/observation-scanner.js";
import {
  RepositoryRefreshConflictError,
  RepositoryRefreshStateError,
  RepositorySourceConflictError,
} from "../../storage/repository-index-store.js";
import { ApiRouteError } from "./router.js";
import { RepositorySourceRevisionConflictError } from "../../storage/project-store.js";

const normalize = (error: unknown): never => {
  if (error instanceof RepositoryRefreshUnavailableError) {
    throw new ApiRouteError(
      409,
      "repository_unavailable",
      "The registered repository is unavailable.",
    );
  }
  if (
    error instanceof RepositoryRefreshConflictError ||
    error instanceof RepositorySourceConflictError ||
    error instanceof RepositoryObservationDriftError ||
    error instanceof RepositoryRefreshInProgressError ||
    error instanceof RepositorySourceRevisionConflictError
  ) {
    throw new ApiRouteError(
      409,
      "repository_refresh_conflict",
      "Repository evidence or project state changed. Review a fresh scan.",
    );
  }
  if (error instanceof RepositoryRefreshStateError) {
    throw new ApiRouteError(
      409,
      "repository_refresh_required",
      "A pending reviewed repository refresh is required.",
    );
  }
  if (error instanceof RepositoryRefreshSelectionError) {
    throw new ApiRouteError(
      400,
      "invalid_request",
      "The request did not pass validation.",
    );
  }
  throw error;
};

export const repositoryRefreshBoundary = <Result>(operation: () => Result): Result => {
  try {
    return operation();
  } catch (error) {
    return normalize(error);
  }
};

export const repositoryRefreshAsyncBoundary = async <Result>(
  operation: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    return normalize(error);
  }
};

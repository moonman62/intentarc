export type ImportApiErrorCode =
  | "import_rescan_required"
  | "import_validation_failed";

export class ImportApiError extends Error {
  constructor(readonly code: ImportApiErrorCode) {
    super(code);
    this.name = "ImportApiError";
  }
}

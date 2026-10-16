/**
 * A single problem found in a diagram.
 *
 * `error` fails the run; `warning` is reported but does not. Everything
 * carries enough location detail to act on without opening the file.
 */
export type Finding = {
  readonly severity: "error" | "warning";
  readonly code: FindingCode;
  readonly message: string;
  readonly pageIndex?: number;
  readonly pageName?: string;
  readonly cellId?: string;
  /** Style key that carried the bad reference, e.g. `shape` or `resIcon`. */
  readonly styleKey?: string;
  /** The unresolved shape/stencil name. */
  readonly shape?: string;
};

export type FindingCode =
  /** The diagram could not be read into Draw.io at all. */
  | "import-failed"
  /** Draw.io logged a console error or threw while rendering. */
  | "browser-error"
  /** A `shape=` style resolved to neither a registered shape nor a stencil. */
  | "unresolved-shape"
  /** A cell produced no view state, so it is in the model but not on screen. */
  | "render-failed"
  /** SVG export of a page failed. */
  | "export-failed"
  /** A page contains no cells. */
  | "empty-page"
  /** The file is not parseable as Draw.io XML. (offline) */
  | "malformed-xml"
  /** The same cell id appears more than once. (offline) */
  | "duplicate-cell-id"
  /** An edge endpoint names a cell that does not exist. (offline) */
  | "dangling-edge"
  /** A cell's parent names a cell that does not exist. (offline) */
  | "missing-parent"
  /** A vertex has zero or negative width/height. (offline) */
  | "degenerate-geometry"
  /** A shape name is absent from the catalogue. (offline) */
  | "unknown-shape";

export type PageStats = {
  readonly index: number;
  readonly name: string | null;
  readonly vertices: number;
  readonly edges: number;
};

export type ValidationResult = {
  readonly name: string;
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  readonly pages: readonly PageStats[];
  /** SVG per page, in page order. Only populated when `exportSvg` is set. */
  readonly svg?: readonly string[];
  readonly durationMs: number;
};

export type ValidateInput = {
  /** Label used in output. Usually the file path. */
  readonly name: string;
  /** Draw.io XML. Either an `<mxGraphModel>` or an `<mxfile>` document. */
  readonly xml: string;
};

export type ValidatorOptions = {
  /** Custom draw.io asset directory. Pin this in CI - see README. */
  readonly assetPath?: string;
  /** Capture SVG for each page alongside the findings. */
  readonly exportSvg?: boolean;
  /**
   * Milliseconds to let Draw.io settle after switching pages before the
   * model is inspected. Raise it for very large diagrams.
   */
  readonly settleMs?: number;
  /** Receives progress lines. Defaults to a no-op. */
  readonly onLog?: (message: string) => void;
};

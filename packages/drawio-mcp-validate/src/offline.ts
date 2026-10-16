import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { XMLParser } from "fast-xml-parser";

import { referencedNames } from "./catalogue.js";
import type { Finding, PageStats, ValidationResult } from "./types.js";

const inflateRawAsync = promisify(inflateRaw);

export type OfflineOptions = {
  /** Shape names considered valid. Omit to skip the vocabulary check. */
  readonly catalogue?: ReadonlySet<string>;
  /** Report an unknown shape as an error rather than a warning. */
  readonly strictShapes?: boolean;
};

type ParsedCell = {
  id: string;
  parent?: string;
  source?: string;
  target?: string;
  style: string;
  isVertex: boolean;
  isEdge: boolean;
  geometry?: { width?: number; height?: number };
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (name) => name === "diagram" || name === "mxCell",
});

/**
 * Validate a diagram without a browser.
 *
 * These are the checks that do not need a renderer: structural integrity and
 * an optional shape-vocabulary check against a catalogue. Milliseconds per
 * file, so run it on every generation and keep the headless render pass for
 * CI.
 */
export async function checkOffline(
  name: string,
  xml: string,
  options: OfflineOptions = {},
): Promise<ValidationResult> {
  const startedAt = Date.now();
  const findings: Finding[] = [];
  const pages: PageStats[] = [];

  const done = (): ValidationResult => ({
    name,
    ok: !findings.some((finding) => finding.severity === "error"),
    findings,
    pages,
    durationMs: Date.now() - startedAt,
  });

  let document: any;
  try {
    document = parser.parse(xml);
  } catch (error) {
    findings.push({
      severity: "error",
      code: "malformed-xml",
      message: error instanceof Error ? error.message : String(error),
    });
    return done();
  }

  const diagrams = await extractDiagrams(document, xml);

  if (diagrams.length === 0) {
    findings.push({
      severity: "error",
      code: "malformed-xml",
      message: "No <mxGraphModel> found; this does not look like a Draw.io file",
    });
    return done();
  }

  diagrams.forEach((diagram, index) => {
    const cells = collectCells(diagram.model);
    const ids = new Set<string>();
    const duplicates = new Set<string>();

    for (const cell of cells) {
      if (ids.has(cell.id)) duplicates.add(cell.id);
      ids.add(cell.id);
    }

    const at = {
      pageIndex: index,
      pageName: diagram.name ?? undefined,
    };

    for (const id of duplicates) {
      findings.push({
        severity: "error",
        code: "duplicate-cell-id",
        message: `Cell id "${id}" is used more than once`,
        cellId: id,
        ...at,
      });
    }

    const drawable = cells.filter((cell) => cell.isVertex || cell.isEdge);

    pages.push({
      index,
      name: diagram.name,
      vertices: drawable.filter((cell) => cell.isVertex).length,
      edges: drawable.filter((cell) => cell.isEdge).length,
    });

    if (drawable.length === 0) {
      findings.push({
        severity: "warning",
        code: "empty-page",
        message: "Page contains no cells",
        ...at,
      });
    }

    for (const cell of cells) {
      if (cell.parent !== undefined && !ids.has(cell.parent)) {
        findings.push({
          severity: "error",
          code: "missing-parent",
          message: `Cell references parent "${cell.parent}", which does not exist`,
          cellId: cell.id,
          ...at,
        });
      }

      for (const [key, value] of [
        ["source", cell.source],
        ["target", cell.target],
      ] as const) {
        if (value !== undefined && !ids.has(value)) {
          findings.push({
            severity: "error",
            code: "dangling-edge",
            message: `Edge ${key} "${value}" does not exist`,
            cellId: cell.id,
            ...at,
          });
        }
      }

      if (
        cell.isVertex &&
        cell.geometry &&
        ((cell.geometry.width !== undefined && cell.geometry.width <= 0) ||
          (cell.geometry.height !== undefined && cell.geometry.height <= 0))
      ) {
        findings.push({
          severity: "warning",
          code: "degenerate-geometry",
          message: `Vertex has non-positive size (${cell.geometry.width ?? "?"}x${cell.geometry.height ?? "?"})`,
          cellId: cell.id,
          ...at,
        });
      }

      if (!options.catalogue) continue;

      for (const reference of referencedNames(cell.style)) {
        if (options.catalogue.has(reference)) continue;

        findings.push({
          severity: options.strictShapes ? "error" : "warning",
          code: "unknown-shape",
          message: `Shape "${reference}" is not in the catalogue; run the headless check to confirm`,
          cellId: cell.id,
          shape: reference,
          ...at,
        });
      }
    }
  });

  return done();
}

type ExtractedDiagram = { name: string | null; model: any };

/**
 * Pull every page's `<mxGraphModel>` out of the file.
 *
 * `<diagram>` content is either an inline model or Draw.io's compressed form
 * (deflateRaw, base64, URI-encoded). Without handling the compressed case
 * every real-world file would read as empty.
 */
async function extractDiagrams(
  document: any,
  raw: string,
): Promise<ExtractedDiagram[]> {
  const file = document?.mxfile;

  if (!file) {
    // A bare <mxGraphModel> document, with no <mxfile> wrapper.
    return document?.mxGraphModel
      ? [{ name: null, model: document.mxGraphModel }]
      : [];
  }

  const diagrams: ExtractedDiagram[] = [];

  for (const diagram of file.diagram ?? []) {
    const name = diagram?.["@name"] ?? null;

    if (diagram?.mxGraphModel) {
      diagrams.push({ name, model: diagram.mxGraphModel });
      continue;
    }

    const payload = typeof diagram === "string" ? diagram : diagram?.["#text"];
    if (typeof payload !== "string" || payload.trim().length === 0) continue;

    const inflated = await inflateDiagram(payload.trim());
    if (!inflated) continue;

    try {
      const model = parser.parse(inflated)?.mxGraphModel;
      if (model) diagrams.push({ name, model });
    } catch {
      // Leave it out; the structural checks will report an empty document.
    }
  }

  if (diagrams.length === 0 && raw.includes("<mxGraphModel")) {
    const model = parser.parse(raw)?.mxGraphModel;
    if (model) diagrams.push({ name: null, model });
  }

  return diagrams;
}

async function inflateDiagram(payload: string): Promise<string | null> {
  try {
    const inflated = await inflateRawAsync(Buffer.from(payload, "base64"));
    return decodeURIComponent(inflated.toString("utf-8"));
  } catch {
    return null;
  }
}

function collectCells(model: any): ParsedCell[] {
  const raw = model?.root?.mxCell ?? [];
  const objects = model?.root?.object ?? [];
  const wrapped = (Array.isArray(objects) ? objects : [objects])
    .filter(Boolean)
    .flatMap((object: any) => {
      // <object> wraps an mxCell to attach custom data; the cell inside
      // carries the geometry and style but inherits the object's id.
      const inner = object.mxCell;
      const cells = Array.isArray(inner) ? inner : inner ? [inner] : [];
      return cells.map((cell: any) => ({ ...cell, "@id": object["@id"] }));
    });

  return [...(Array.isArray(raw) ? raw : [raw]), ...wrapped]
    .filter(Boolean)
    .map((cell: any) => {
      const geometry = cell.mxGeometry;
      return {
        id: String(cell["@id"] ?? ""),
        parent: cell["@parent"] !== undefined ? String(cell["@parent"]) : undefined,
        source: cell["@source"] !== undefined ? String(cell["@source"]) : undefined,
        target: cell["@target"] !== undefined ? String(cell["@target"]) : undefined,
        style: String(cell["@style"] ?? ""),
        isVertex: cell["@vertex"] === "1" || cell["@vertex"] === 1,
        isEdge: cell["@edge"] === "1" || cell["@edge"] === 1,
        geometry: geometry
          ? {
              width: numeric(geometry["@width"]),
              height: numeric(geometry["@height"]),
            }
          : undefined,
      };
    });
}

function numeric(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

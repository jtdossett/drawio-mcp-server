import {
  createValidationSession,
  type ValidationSession,
} from "./session.js";
import { countPages, inspectVisiblePage, selectPage } from "./checks.js";
import type {
  Finding,
  PageStats,
  ValidateInput,
  ValidationResult,
  ValidatorOptions,
} from "./types.js";

export type Validator = {
  validate: (input: ValidateInput) => Promise<ValidationResult>;
  close: () => Promise<void>;
};

const DEFAULT_SETTLE_MS = 250;

/**
 * Boot one headless Draw.io and return a handle that validates diagrams
 * through it. Reuse a single validator for a whole run - the boot is the
 * expensive part, each diagram after that is fast.
 */
export async function createValidator(
  options: ValidatorOptions = {},
): Promise<Validator> {
  const session = await createValidationSession({
    assetPath: options.assetPath,
    onLog: options.onLog,
  });

  return {
    validate: (input) => validateOne(session, input, options),
    close: () => session.close(),
  };
}

/** Convenience wrapper: boot, validate everything, tear down. */
export async function validateAll(
  inputs: readonly ValidateInput[],
  options: ValidatorOptions = {},
): Promise<ValidationResult[]> {
  const validator = await createValidator(options);
  try {
    const results: ValidationResult[] = [];
    for (const input of inputs) {
      results.push(await validator.validate(input));
    }
    return results;
  } finally {
    await validator.close();
  }
}

async function validateOne(
  session: ValidationSession,
  input: ValidateInput,
  options: ValidatorOptions,
): Promise<ValidationResult> {
  const startedAt = Date.now();
  const findings: Finding[] = [];
  const pages: PageStats[] = [];
  const svg: string[] = [];
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;

  // Only messages produced while this diagram is loaded belong to it.
  const messageMark = session.messages.length;

  const loaded = await loadDocument(session, input.xml);

  if (!loaded.ok) {
    findings.push({
      severity: "error",
      code: "import-failed",
      message: loaded.message,
    });
    return {
      name: input.name,
      ok: false,
      findings,
      pages,
      durationMs: Date.now() - startedAt,
    };
  }

  await session.page.waitForTimeout(settleMs);

  const pageCount = await countPages(session.page);

  for (let index = 0; index < pageCount; index += 1) {
    await selectPage(session.page, index);
    await session.page.waitForTimeout(settleMs);

    const inspection = await inspectVisiblePage(session.page);

    pages.push({
      index,
      name: inspection.name,
      vertices: inspection.vertices,
      edges: inspection.edges,
    });

    if (inspection.cells.length === 0) {
      findings.push({
        severity: "warning",
        code: "empty-page",
        message: "Page contains no cells",
        pageIndex: index,
        pageName: inspection.name ?? undefined,
      });
    }

    for (const cell of inspection.cells) {
      for (const reference of cell.references) {
        if (reference.resolved) continue;

        const rendered =
          reference.key === "shape"
            ? `; Draw.io rendered a plain ${cell.renderedAs ?? "box"} instead`
            : "; Draw.io rendered the shape without that icon";

        findings.push({
          severity: "error",
          code: "unresolved-shape",
          message: `Style "${reference.key}=${reference.value}" matches no registered shape or stencil${rendered}`,
          pageIndex: index,
          pageName: inspection.name ?? undefined,
          cellId: cell.id,
          styleKey: reference.key,
          shape: reference.value,
        });
      }

      if (!cell.hasState) {
        findings.push({
          severity: "error",
          code: "render-failed",
          message: "Cell is present in the model but produced no view state",
          pageIndex: index,
          pageName: inspection.name ?? undefined,
          cellId: cell.id,
        });
      }
    }

    if (options.exportSvg) {
      const exported = await exportPageSvg(session, index);
      if (exported.ok) {
        svg.push(exported.svg);
      } else {
        findings.push({
          severity: "error",
          code: "export-failed",
          message: exported.message,
          pageIndex: index,
          pageName: inspection.name ?? undefined,
        });
      }
    }
  }

  // Console events are delivered asynchronously, so a late message from this
  // diagram would otherwise land in the next one's slice. Drain before
  // reading.
  await session.page.waitForTimeout(settleMs);

  for (const message of session.messages.slice(messageMark)) {
    if (message.type !== "error") continue;
    findings.push({
      severity: "error",
      code: "browser-error",
      message: message.text,
    });
  }

  return {
    name: input.name,
    ok: !findings.some((finding) => finding.severity === "error"),
    findings,
    pages,
    ...(options.exportSvg ? { svg } : {}),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Load the document the way Draw.io loads a file.
 *
 * Deliberately not the `import-diagram` MCP tool: that replaces the current
 * page's model, so a multi-page `<mxfile>` would silently validate only its
 * first diagram. `setFileData` rebuilds the whole page set.
 */
async function loadDocument(
  session: ValidationSession,
  xml: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await session.page.evaluate((data: string) => {
    try {
      const ui = (window as any).ui;
      ui.setFileData(data);
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }, xml);

  if (!result.ok) {
    return { ok: false, message: `Draw.io could not load the document: ${result.message}` };
  }

  // setFileData swallows some malformed input rather than throwing, leaving
  // an empty document behind, so confirm a page set actually materialised.
  const pageCount = await countPages(session.page);
  if (pageCount === 0) {
    return {
      ok: false,
      message: "Draw.io loaded the document but produced no pages",
    };
  }

  return { ok: true };
}

async function exportPageSvg(
  session: ValidationSession,
  pageIndex: number,
): Promise<{ ok: true; svg: string } | { ok: false; message: string }> {
  try {
    const response = await session.client.callTool({
      name: "export-diagram",
      arguments: {
        target_page: { index: pageIndex },
        format: "svg",
      },
    });

    // export-diagram returns the SVG as raw text, optionally preceded by a
    // "Warning: ..." entry and always followed by a human-readable summary.
    // A failure comes back as a single "Export failed: ..." entry.
    const content =
      (response as { content?: { type?: string; text?: string }[] }).content ??
      [];
    const texts = content
      .filter((entry) => entry.type === "text")
      .map((entry) => entry.text ?? "");

    const failure = texts.find((text) => text.startsWith("Export failed:"));
    if (failure) {
      return { ok: false, message: failure };
    }

    const svg = texts.find((text) => text.trimStart().startsWith("<"));
    if (!svg) {
      return { ok: false, message: "Export returned no SVG payload" };
    }

    return { ok: true, svg };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

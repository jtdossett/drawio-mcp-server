import { createValidationSession } from "./session.js";

export type ShapeCatalogue = {
  /** Draw.io version the catalogue was extracted from. */
  readonly drawioVersion: string | null;
  readonly generatedAt: string;
  /** Sorted, de-duplicated shape and stencil names. */
  readonly shapes: readonly string[];
};

/**
 * Extract the shape vocabulary from a real Draw.io.
 *
 * Three sources are merged:
 *
 * - `mxCellRenderer.defaultShapes` - every shape implemented in JS, which
 *   covers the built-ins (`cylinder`, `cloud`, ...) and most `mxgraph.*`
 *   host shapes.
 * - The vendor palettes the plugin extracts from the sidebar, whose styles
 *   carry the stencil names used for icons (`resIcon`, `prIcon`, ...).
 * - Whatever stencils happen to be loaded, which rendering may have pulled in.
 *
 * The union is close to complete but not provably so: stencils load lazily,
 * so a valid stencil that no palette offers can be missing. That is why the
 * offline checker reports an unknown shape as a warning by default - see
 * `checkOffline`.
 */
export async function extractCatalogue(options: {
  assetPath?: string;
  onLog?: (message: string) => void;
} = {}): Promise<ShapeCatalogue> {
  const log = options.onLog ?? (() => {});
  const session = await createValidationSession({
    assetPath: options.assetPath,
    onLog: log,
  });

  try {
    const names = new Set<string>();

    const fromRuntime = await session.page.evaluate(() => {
      const win = window as unknown as Record<string, any>;
      return {
        version: win.EditorUi?.VERSION ?? null,
        registered: Object.keys(win.mxCellRenderer?.defaultShapes ?? {}),
        stencils: Object.keys(win.mxStencilRegistry?.stencils ?? {}),
      };
    });

    for (const name of fromRuntime.registered) names.add(name);
    for (const name of fromRuntime.stencils) names.add(name);
    log(`${names.size} names from the Draw.io runtime`);

    const categories = await callJson<string[]>(session, "get-shape-categories", {});

    let paletteCount = 0;
    for (const category of categories ?? []) {
      const shapes = await callJson<{ id?: string; style?: string }[]>(
        session,
        "get-shapes-in-category",
        { category_id: category },
      );

      for (const shape of shapes ?? []) {
        // The catalogue lists shapes as {id, title}; the id is the shape or
        // stencil name (e.g. mxgraph.aws4.lambda), which is the icon name a
        // style's resIcon/prIcon refers to.
        if (shape?.id) {
          names.add(shape.id);
          paletteCount += 1;
        }
        // Some entries may also carry a full style; mine it for anything the
        // id alone does not cover.
        if (shape?.style) {
          for (const name of referencedNames(shape.style)) names.add(name);
        }
      }
    }
    log(`${categories?.length ?? 0} categories, ${paletteCount} palette shapes`);

    return {
      drawioVersion: fromRuntime.version,
      generatedAt: new Date().toISOString(),
      shapes: [...names].sort(),
    };
  } finally {
    await session.close();
  }
}

/**
 * Pull every shape/stencil name out of a style string.
 *
 * Mirrors the rule the in-browser check uses: `shape=` always names a shape,
 * and any other key does when its value is in the mxgraph namespace.
 */
export function referencedNames(style: string): string[] {
  const names: string[] = [];

  for (const entry of style.split(";")) {
    const eq = entry.indexOf("=");
    if (eq < 1) continue;

    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();
    if (!value) continue;
    if (key !== "shape" && !value.startsWith("mxgraph.")) continue;
    if (value.startsWith("stencil(")) continue;

    names.push(value);
  }

  return names;
}

async function callJson<T>(
  session: Awaited<ReturnType<typeof createValidationSession>>,
  name: string,
  args: Record<string, unknown>,
): Promise<T | null> {
  const response = await session.client.callTool({ name, arguments: args });
  const content = (response as { content?: { text?: string }[] }).content ?? [];
  const text = content[0]?.text ?? "";

  try {
    const parsed = JSON.parse(text) as { result?: T } | T;
    if (parsed && typeof parsed === "object" && "result" in parsed) {
      return (parsed as { result?: T }).result ?? null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

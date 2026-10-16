import type { Page } from "playwright";

/** A style entry that names a shape or stencil, and whether it resolved. */
export type StyleReference = {
  /** Style key, e.g. `shape` or `resIcon`. */
  key: string;
  /** The referenced shape/stencil name. */
  value: string;
  resolved: boolean;
};

export type CellInspection = {
  id: string;
  isVertex: boolean;
  /** Every shape/stencil reference in the cell style. */
  references: StyleReference[];
  /** Constructor name of the shape Draw.io actually rendered. */
  renderedAs: string | null;
  hasState: boolean;
};

export type PageInspection = {
  name: string | null;
  vertices: number;
  edges: number;
  cells: CellInspection[];
};

/** Number of pages in the currently loaded document. */
export async function countPages(page: Page): Promise<number> {
  return page.evaluate(() => {
    const ui = (window as any).ui;
    return ui?.pages?.length ?? 0;
  });
}

/**
 * Make page `index` the visible one.
 *
 * Shape resolution has to happen against a rendered page: Draw.io loads
 * stencil sets lazily, on first render, so an unvisited page reports every
 * stencil shape as missing.
 */
export async function selectPage(page: Page, index: number): Promise<void> {
  await page.evaluate((idx: number) => {
    const ui = (window as any).ui;
    if (ui?.pages?.[idx]) {
      ui.selectPage(ui.pages[idx]);
    }
  }, index);
}

/**
 * Inspect the visible page's model and its rendered state.
 *
 * The interesting case is a style reference that resolves to nothing: Draw.io
 * does not raise an error, it silently falls back to a plain rectangle (or
 * draws no icon at all). A typo in a generated style is invisible otherwise.
 *
 * Both kinds of reference are checked. `shape=` names the shape itself, but
 * vendor palettes put the actual icon in a second key - `resIcon`, `prIcon`
 * and friends - whose value is a lazily loaded stencil. A typo there is the
 * most likely mistake in a generated AWS/Azure/GCP diagram and leaves the
 * host shape resolving perfectly well.
 */
export async function inspectVisiblePage(page: Page): Promise<PageInspection> {
  return page.evaluate(() => {
    const ui = (window as any).ui;
    const graph = ui.editor.graph;
    const model = graph.getModel();

    const renderer = (window as any).mxCellRenderer;
    const stencils = (window as any).mxStencilRegistry;

    const cells: CellInspection[] = [];
    let vertices = 0;
    let edges = 0;

    for (const cell of Object.values(model.cells) as any[]) {
      const isVertex = Boolean(cell.vertex);
      const isEdge = Boolean(cell.edge);
      if (!isVertex && !isEdge) continue; // the root and default layer

      if (isVertex) vertices += 1;
      if (isEdge) edges += 1;

      const resolves = (name: string): boolean => {
        if (renderer?.defaultShapes?.[name]) return true;
        try {
          return Boolean(stencils?.getStencil?.(name));
        } catch {
          return false;
        }
      };

      const style: string = cell.style ?? "";
      const references: StyleReference[] = [];

      for (const entry of style.split(";")) {
        const eq = entry.indexOf("=");
        if (eq < 1) continue;

        const key = entry.slice(0, eq).trim();
        const value = entry.slice(eq + 1).trim();
        if (!value) continue;

        // `shape=` is always a shape reference. Any other key is one only
        // when it names something in the mxgraph namespace.
        const isShapeKey = key === "shape";
        if (!isShapeKey && !value.startsWith("mxgraph.")) continue;

        // An inline stencil carries its own definition; there is nothing to
        // look up and the payload is not a name.
        if (value.startsWith("stencil(")) continue;

        references.push({ key, value, resolved: resolves(value) });
      }

      const state = graph.view.getState(cell);

      cells.push({
        id: String(cell.id),
        isVertex,
        references,
        renderedAs: state?.shape?.constructor?.name ?? null,
        hasState: Boolean(state),
      });
    }

    return {
      name: ui.currentPage?.getName?.() ?? null,
      vertices,
      edges,
      cells,
    };
  }) as Promise<PageInspection>;
}

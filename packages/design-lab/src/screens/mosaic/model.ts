/**
 * The mosaic's layout model, ported from the Studio
 * (`samantha-ui/src/lib/mosaic-model.ts`, lines 23-25 for the shape and
 * 80-83 / 441-480 / 761-797 for the five helpers this screen needs).
 *
 * Only the layout half came across. The Studio's file also owns opening,
 * closing, moving and persisting panes plus a tool/session id vocabulary
 * ("browser", "terminal", `session:<id>`) that means nothing in a design lab,
 * so a pane id here is just a string.
 *
 * Sizes are weights, not percentages: the render layer emits them as `fr`
 * tracks and `flex-grow`, so they only ever matter relative to their siblings.
 */

export type MosaicPaneId = string;
export type MosaicPane = { id: MosaicPaneId; size: number };
export type MosaicColumn = { size: number; panes: MosaicPane[] };
export type MosaicModel = { v: 2; columns: MosaicColumn[] };

/** Track id for a column, so the model and the render layer stay in sync. */
export function mosaicColumnId(index: number): string {
  return `col-${index}`;
}

/** Write back column sizes only; structure untouched. */
export function applyColumnLayout(
  model: MosaicModel,
  sizes: Record<string, number>,
): MosaicModel {
  return {
    v: 2,
    columns: model.columns.map((c, i) => {
      const s = sizes[mosaicColumnId(i)];
      return typeof s === "number" && Number.isFinite(s) && s > 0
        ? { size: s, panes: c.panes }
        : c;
    }),
  };
}

/** Write back one column's pane sizes only; structure untouched. */
export function applyPaneLayout(
  model: MosaicModel,
  colIndex: number,
  sizes: Record<string, number>,
): MosaicModel {
  return {
    v: 2,
    columns: model.columns.map((c, i) => {
      if (i !== colIndex) return c;
      return {
        size: c.size,
        panes: c.panes.map((p) => {
          const s = sizes[p.id];
          return typeof s === "number" && Number.isFinite(s) && s > 0
            ? { id: p.id, size: s }
            : p;
        }),
      };
    }),
  };
}

/**
 * Double-click a column grip: even-split the two columns that share it.
 * Other columns keep their sizes. No-op when the index is not a real grip.
 */
export function evenSplitAdjacentColumns(
  model: MosaicModel,
  leftIndex: number,
): MosaicModel {
  const cols = model.columns;
  if (leftIndex < 0 || leftIndex >= cols.length - 1) return model;
  const pair = cols[leftIndex].size + cols[leftIndex + 1].size;
  const half = pair / 2;
  return {
    v: 2,
    columns: cols.map((c, i) =>
      i === leftIndex || i === leftIndex + 1
        ? { size: half, panes: c.panes }
        : c,
    ),
  };
}

/**
 * Double-click a row grip: even-split every row in that column. Other columns
 * unchanged. No-op when the column has fewer than two panes.
 */
export function evenSplitColumnRows(
  model: MosaicModel,
  colIndex: number,
): MosaicModel {
  const col = model.columns[colIndex];
  if (!col || col.panes.length < 2) return model;
  const size = 100 / col.panes.length;
  return {
    v: 2,
    columns: model.columns.map((c, i) =>
      i === colIndex
        ? { size: c.size, panes: c.panes.map((p) => ({ id: p.id, size })) }
        : c,
    ),
  };
}

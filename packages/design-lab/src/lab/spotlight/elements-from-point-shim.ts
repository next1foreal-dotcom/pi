/**
 * jsdom has no `Document.elementsFromPoint`. The pick tool's `containerOf`
 * walks that list innermost-first and takes the first pickable whose own rect
 * swallows a drawn region. Without a shim, every region-up throws inside the
 * listener and that walker never runs.
 *
 * Geometry is whatever `getBoundingClientRect` returns — including the
 * `Object.defineProperty` stubs the pick tests already plant. A second
 * coordinate system here would be a second set of facts.
 *
 * Hits are only elements whose rect contains the point. Returning everyone
 * and letting `containerOf` filter would skip the half of the API it depends
 * on (the list is already innermost-first and already a hit test).
 */

function rectContainsPoint(
  r: { left: number; top: number; right: number; bottom: number },
  x: number,
  y: number,
): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/**
 * Paint order, topmost first: descendants over ancestors, later siblings over
 * earlier ones. Matches what `containerOf` comments as "innermost first".
 */
function topmostFirst(a: Element, b: Element): number {
  if (a === b) return 0;
  const pos = a.compareDocumentPosition(b);
  if (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) return 1;
  if (pos & Node.DOCUMENT_POSITION_CONTAINS) return -1;
  if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return 1;
  if (pos & Node.DOCUMENT_POSITION_PRECEDING) return -1;
  return 0;
}

export function elementsFromPoint(doc: Document, x: number, y: number): Element[] {
  const root = doc.documentElement;
  if (!root) return [];
  const hits: Element[] = [];
  const walk = (el: Element): void => {
    if (rectContainsPoint(el.getBoundingClientRect(), x, y)) hits.push(el);
    const kids = el.children;
    for (let i = 0; i < kids.length; i++) walk(kids[i]!);
  };
  walk(root);
  hits.sort(topmostFirst);
  return hits;
}

export function installElementsFromPointShim(): () => void {
  const proto = Document.prototype;
  const prior = Object.getOwnPropertyDescriptor(proto, "elementsFromPoint");
  Object.defineProperty(proto, "elementsFromPoint", {
    configurable: true,
    enumerable: true,
    writable: true,
    value(this: Document, x: number, y: number): Element[] {
      return elementsFromPoint(this, x, y);
    },
  });
  return () => {
    if (prior) Object.defineProperty(proto, "elementsFromPoint", prior);
    else Reflect.deleteProperty(proto, "elementsFromPoint");
  };
}

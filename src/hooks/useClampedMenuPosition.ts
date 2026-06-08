import { RefObject, useLayoutEffect, useState } from "react";

/** Gap kept between a floating menu and the viewport edges. */
const VIEWPORT_MARGIN = 8;

export type MenuAnchor = { x: number; y: number } | null | undefined;

/**
 * Keeps a portal-rendered floating menu (context menu, picker, …) fully inside
 * the viewport.
 *
 * Pass the menu element's ref and the requested anchor point (usually the mouse
 * `clientX`/`clientY`). After the menu renders, the hook measures it and returns
 * a `{ left, top }` that:
 *   - opens right/down from the anchor by default,
 *   - flips to the left of / above the anchor when it would overflow the right /
 *     bottom edge (so the menu stays anchored to the click, not jammed against
 *     the edge),
 *   - clamps to a small margin from every edge as a final fallback.
 *
 * Measuring happens in `useLayoutEffect`, so the correction lands before paint —
 * the menu never flashes at the unclamped position. The menu's own CSS should
 * cap its height (`max-height` + `overflow-y: auto`) so a menu taller than the
 * viewport scrolls; this hook then positions that capped box.
 */
export function useClampedMenuPosition(
  ref: RefObject<HTMLElement | null>,
  anchor: MenuAnchor,
): { left: number; top: number } {
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: anchor?.x ?? 0,
    top: anchor?.y ?? 0,
  });

  const anchorX = anchor?.x ?? null;
  const anchorY = anchor?.y ?? null;

  useLayoutEffect(() => {
    if (anchorX === null || anchorY === null) return;

    const el = ref.current;
    if (!el) {
      setPos({ left: anchorX, top: anchorY });
      return;
    }

    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxLeft = vw - width - VIEWPORT_MARGIN;
    const maxTop = vh - height - VIEWPORT_MARGIN;

    // Horizontal: open rightward; flip to the left of the anchor on overflow.
    let left = anchorX;
    if (left > maxLeft) left = anchorX - width;
    left = Math.min(Math.max(VIEWPORT_MARGIN, left), Math.max(VIEWPORT_MARGIN, maxLeft));

    // Vertical: open downward; flip above the anchor on overflow (the bug in the
    // report — a click low in a tall sidebar pushed the menu off the bottom).
    let top = anchorY;
    if (top > maxTop) top = anchorY - height;
    top = Math.min(Math.max(VIEWPORT_MARGIN, top), Math.max(VIEWPORT_MARGIN, maxTop));

    setPos({ left, top });
  }, [ref, anchorX, anchorY]);

  return pos;
}

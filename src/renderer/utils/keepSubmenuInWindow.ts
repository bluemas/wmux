/**
 * Ref callback for a context-menu submenu that opens beside its item
 * (`absolute top-0` under a `relative` item). On a menu near the bottom of the
 * window the submenu would run off the edge and hide its last entries, so it
 * is lifted just enough to fit. Submenus that fill in after opening (account
 * and profile lists) are refitted when their size changes.
 *
 * Offsets, not getBoundingClientRect, size the submenu: the scale-in animation
 * would report it smaller than it lays out.
 */
const MARGIN = 4;

export function fitSubmenuTop(itemTop: number, height: number, viewportHeight: number): number {
  const overflow = itemTop + height - (viewportHeight - MARGIN);
  if (overflow <= 0) return 0;
  return -Math.max(0, Math.min(overflow, itemTop - MARGIN));
}

export function keepSubmenuInWindow(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  const fit = () => {
    const item = el.offsetParent;
    if (!item) return;
    const top = fitSubmenuTop(item.getBoundingClientRect().top, el.offsetHeight, window.innerHeight);
    el.style.top = `${top}px`;
  };
  fit();
  if (typeof ResizeObserver === 'undefined') return undefined;
  const observer = new ResizeObserver(fit);
  observer.observe(el);
  return () => observer.disconnect();
}

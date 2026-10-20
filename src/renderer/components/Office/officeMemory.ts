// The Office page's last layout, kept outside the component: the rail
// unmounts the page while it is hidden, and each employee's desk and place in
// the boss queue (its queue stamp) must survive that.
import type { OfficeLayout } from './officeLayout';

let last: OfficeLayout | undefined;

/** The layout to continue from when the page mounts again. */
export function rememberedOfficeLayout(): OfficeLayout | undefined {
  return last;
}

export function rememberOfficeLayout(layout: OfficeLayout): void {
  last = layout;
}

/** Start from an empty office (tests). */
export function forgetOfficeLayout(): void {
  last = undefined;
}

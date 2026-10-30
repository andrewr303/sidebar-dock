// Sticky notes: notes with a `sticky` field shown as colored notes (placeholder until the stickies module is implemented).
import { html } from './html.js';

/** Main-area renderer for the 'stickies' view (all sticky notes). */
export function renderStickiesView(ctx) {
  return html`<div class="stickies-view" data-key="stickies-view"><h1>Sticky notes</h1></div>`;
}

/** Floating sticky notes over the dashboard grid for a board. */
export function renderStickyLayer(ctx, { boardId } = {}) {
  return '';
}

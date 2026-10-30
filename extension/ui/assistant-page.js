// Full-screen AI assistant view (placeholder until the assistant page module is implemented).
import { html } from './html.js';
import { renderAiPanel } from './ai-panel.js';

/** Main-area renderer for the 'assistant' view. */
export function renderAssistantPage(ctx) {
  return html`<div class="assistant-page" data-key="assistant-page">${renderAiPanel(ctx, { surface: 'full' })}</div>`;
}

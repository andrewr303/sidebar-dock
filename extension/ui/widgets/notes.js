// Notes widget (placeholder until its module is implemented).
import { html } from '../html.js';
import { defineWidget } from '../dashboard/registry.js';

defineWidget({
  type: 'notes',
  title: 'Notes',
  description: '',
  icon: 'sticky-note',
  category: 'library',
  size: { w: 3, h: 3 },
  defaults: () => ({}),
  render: () => html`<p class="widget-placeholder">Notes is on its way.</p>`,
});

// Sticky notes widget (placeholder until its module is implemented).
import { html } from '../html.js';
import { defineWidget } from '../dashboard/registry.js';

defineWidget({
  type: 'sticky-notes',
  title: 'Sticky notes',
  description: '',
  icon: 'sticker',
  category: 'library',
  size: { w: 3, h: 3 },
  defaults: () => ({}),
  render: () => html`<p class="widget-placeholder">Sticky notes is on its way.</p>`,
});

// Linear widget (placeholder until its module is implemented).
import { html } from '../html.js';
import { defineWidget } from '../dashboard/registry.js';

defineWidget({
  type: 'linear',
  title: 'Linear',
  description: '',
  icon: 'layers',
  category: 'developer',
  size: { w: 3, h: 3 },
  defaults: () => ({}),
  render: () => html`<p class="widget-placeholder">Linear is on its way.</p>`,
});

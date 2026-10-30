// Weather widget (placeholder until its module is implemented).
import { html } from '../html.js';
import { defineWidget } from '../dashboard/registry.js';

defineWidget({
  type: 'weather',
  title: 'Weather',
  description: '',
  icon: 'cloud-sun',
  category: 'info',
  size: { w: 3, h: 3 },
  defaults: () => ({}),
  render: () => html`<p class="widget-placeholder">Weather is on its way.</p>`,
});

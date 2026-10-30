// Most visited widget (placeholder until its module is implemented).
import { html } from '../html.js';
import { defineWidget } from '../dashboard/registry.js';

defineWidget({
  type: 'most-visited',
  title: 'Most visited',
  description: '',
  icon: 'trending-up',
  category: 'web',
  size: { w: 3, h: 3 },
  defaults: () => ({}),
  render: () => html`<p class="widget-placeholder">Most visited is on its way.</p>`,
});

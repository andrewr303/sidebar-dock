// Product Hunt widget (placeholder until its module is implemented).
import { html } from '../html.js';
import { defineWidget } from '../dashboard/registry.js';

defineWidget({
  type: 'product-hunt',
  title: 'Product Hunt',
  description: '',
  icon: 'rocket',
  category: 'web',
  size: { w: 3, h: 3 },
  defaults: () => ({}),
  render: () => html`<p class="widget-placeholder">Product Hunt is on its way.</p>`,
});

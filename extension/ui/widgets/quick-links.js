// Quick links widget (placeholder until its module is implemented).
import { html } from '../html.js';
import { defineWidget } from '../dashboard/registry.js';

defineWidget({
  type: 'quick-links',
  title: 'Quick links',
  description: '',
  icon: 'link',
  category: 'web',
  size: { w: 3, h: 3 },
  defaults: () => ({}),
  render: () => html`<p class="widget-placeholder">Quick links is on its way.</p>`,
});

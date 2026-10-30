// GitHub widget (placeholder until its module is implemented).
import { html } from '../html.js';
import { defineWidget } from '../dashboard/registry.js';

defineWidget({
  type: 'github',
  title: 'GitHub',
  description: '',
  icon: 'github',
  category: 'developer',
  size: { w: 3, h: 3 },
  defaults: () => ({}),
  render: () => html`<p class="widget-placeholder">GitHub is on its way.</p>`,
});

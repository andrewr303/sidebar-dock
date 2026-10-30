// Website widget (placeholder until its module is implemented).
import { html } from '../html.js';
import { defineWidget } from '../dashboard/registry.js';

defineWidget({
  type: 'embed',
  title: 'Website',
  description: '',
  icon: 'app-window',
  category: 'web',
  size: { w: 3, h: 3 },
  defaults: () => ({}),
  render: () => html`<p class="widget-placeholder">Website is on its way.</p>`,
});

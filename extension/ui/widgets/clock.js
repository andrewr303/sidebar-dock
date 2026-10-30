// Clock widget (placeholder until its module is implemented).
import { html } from '../html.js';
import { defineWidget } from '../dashboard/registry.js';

defineWidget({
  type: 'clock',
  title: 'Clock',
  description: '',
  icon: 'clock',
  category: 'info',
  size: { w: 3, h: 3 },
  defaults: () => ({}),
  render: () => html`<p class="widget-placeholder">Clock is on its way.</p>`,
});

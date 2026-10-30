// Calendar widget (placeholder until its module is implemented).
import { html } from '../html.js';
import { defineWidget } from '../dashboard/registry.js';

defineWidget({
  type: 'calendar',
  title: 'Calendar',
  description: '',
  icon: 'calendar',
  category: 'info',
  size: { w: 3, h: 3 },
  defaults: () => ({}),
  render: () => html`<p class="widget-placeholder">Calendar is on its way.</p>`,
});

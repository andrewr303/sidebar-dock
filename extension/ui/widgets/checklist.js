// Checklist widget (placeholder until its module is implemented).
import { html } from '../html.js';
import { defineWidget } from '../dashboard/registry.js';

defineWidget({
  type: 'checklist',
  title: 'Checklist',
  description: '',
  icon: 'list-checks',
  category: 'library',
  size: { w: 3, h: 3 },
  defaults: () => ({}),
  render: () => html`<p class="widget-placeholder">Checklist is on its way.</p>`,
});

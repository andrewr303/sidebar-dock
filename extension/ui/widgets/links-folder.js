// Links folder widget (placeholder until its module is implemented).
import { html } from '../html.js';
import { defineWidget } from '../dashboard/registry.js';

defineWidget({
  type: 'links-folder',
  title: 'Links folder',
  description: '',
  icon: 'folder',
  category: 'library',
  size: { w: 3, h: 3 },
  defaults: () => ({}),
  render: () => html`<p class="widget-placeholder">Links folder is on its way.</p>`,
});

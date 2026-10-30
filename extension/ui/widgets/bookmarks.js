// Bookmarks widget (placeholder until its module is implemented).
import { html } from '../html.js';
import { defineWidget } from '../dashboard/registry.js';

defineWidget({
  type: 'bookmarks',
  title: 'Bookmarks',
  description: '',
  icon: 'bookmark',
  category: 'web',
  size: { w: 3, h: 3 },
  defaults: () => ({}),
  render: () => html`<p class="widget-placeholder">Bookmarks is on its way.</p>`,
});

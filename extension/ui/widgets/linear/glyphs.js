// Linear glyphs: workflow-status circles, priority bars, the Linear mark and people avatars. The colored versions are
// inline SVG (state colors come from Linear and are sanitized to #hex); monochrome copies are registered as icons so
// menus can show them through ui/icons.js.
import { html, raw, cx, safeSrc } from '../../html.js';
import { registerIcons } from '../../icons.js';
import { avatarTile } from '../../components.js';
import { safeColor, stateTypeOf, priorityOf } from '../../../lib/linear.js';

// Linear's mark (Simple Icons, CC0) plus 24px monochrome status and priority icons for menus.
registerIcons({
  linear: '<path fill="currentColor" stroke="none" d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"/>',
  'linear-backlog': '<circle cx="12" cy="12" r="8" stroke-dasharray="2.6 2.6"/>',
  'linear-unstarted': '<circle cx="12" cy="12" r="8"/>',
  'linear-started': '<circle cx="12" cy="12" r="8"/><path d="M12 7a5 5 0 0 1 0 10Z" fill="currentColor" stroke="none"/>',
  'linear-completed': '<circle cx="12" cy="12" r="8"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>',
  'linear-canceled': '<circle cx="12" cy="12" r="8"/><path d="m9.5 9.5 5 5m0-5-5 5"/>',
  'linear-triage': '<circle cx="12" cy="12" r="8"/><path d="M8.5 10.5h7l-2-2M15.5 13.5h-7l2 2"/>',
  'linear-priority-0': '<path d="M5 12h2.5M10.75 12h2.5M16.5 12H19"/>',
  'linear-priority-1': '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v5M12 16v.01"/>',
  'linear-priority-2': '<path d="M6 18v-4M12 18V10M18 18V6"/>',
  'linear-priority-3': '<path d="M6 18v-4M12 18V10"/><path d="M18 18V6" opacity=".35"/>',
  'linear-priority-4': '<path d="M6 18v-4"/><path d="M12 18V10M18 18V6" opacity=".35"/>',
});

/** Linear's grays (Todo, Backlog, Canceled) read as neutral: they take the theme's muted ink instead of a fixed gray. */
function chromatic(hex) {
  if (!hex) return false;
  const v = hex.length <= 5 ? hex.slice(1, 4).split('').map(c => parseInt(c + c, 16)) : [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const max = Math.max(...v) / 255, min = Math.min(...v) / 255, l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  return s >= 0.2;
}

/** Fraction of the "started" pie: review-like states read as further along, like Linear shows them. */
const startedFraction = name => /review|qa|verify|testing|ready/i.test(name || '') ? 0.75 : 0.5;

function pie(fraction, r = 3.25, c = 7) {
  const angle = Math.PI * 2 * Math.min(0.999, fraction);
  const x = (c + r * Math.sin(angle)).toFixed(2);
  const y = (c - r * Math.cos(angle)).toFixed(2);
  return `M${c} ${c}V${c - r}A${r} ${r} 0 ${fraction > 0.5 ? 1 : 0} 1 ${x} ${y}Z`;
}

/**
 * Colored status circle for a workflow state (14px by default). The fill knocks out with --w-linear-knock so the check
 * or cross stays readable on any state color. Decorative: callers label the button or row that contains it.
 */
export function statusGlyph(state, { size = 14, className } = {}) {
  const type = stateTypeOf(state?.type).type;
  const color = chromatic(safeColor(state?.color)) ? safeColor(state.color) : '';
  const knock = 'style="stroke:var(--w-linear-knock)"';
  const shapes = {
    backlog: '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="1.55 1.6"/>',
    unstarted: '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    started: `<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="${pie(startedFraction(state?.name))}" fill="currentColor"/>`,
    completed: `<circle cx="7" cy="7" r="6.25" fill="currentColor"/><path d="m4.4 7.15 1.75 1.75 3.45-3.6" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${knock}/>`,
    canceled: `<circle cx="7" cy="7" r="6.25" fill="currentColor"/><path d="m5 5 4 4m0-4-4 4" fill="none" stroke-width="1.5" stroke-linecap="round" ${knock}/>`,
    triage: `<circle cx="7" cy="7" r="6.25" fill="currentColor"/><path d="M4.4 6.1h5.2L8.3 4.8M9.6 7.9H4.4l1.3 1.3" fill="none" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" ${knock}/>`,
  };
  return html`<svg class="${cx('w-linear-status-glyph', className)}" data-type="${type}" width="${size}" height="${size}" viewBox="0 0 14 14"
    ${color ? html`style="--st:${color}"` : ''} aria-hidden="true" focusable="false">${raw(shapes[type])}</svg>`;
}

/** Priority bars (Low/Medium/High), the urgent badge, or three dashes for no priority. */
export function priorityGlyph(priority, { size = 14, className } = {}) {
  const p = priorityOf(priority).value;
  let inner;
  if (p === 1) inner = `<rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor"/><path d="M7 3.9v3.7M7 9.9v.2" fill="none" stroke-width="1.6" stroke-linecap="round" style="stroke:var(--w-linear-knock)"/>`;
  else if (p === 0) inner = '<path d="M2 7h2M6 7h2M10 7h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".7"/>';
  else {
    const filled = { 2: 3, 3: 2, 4: 1 }[p];
    inner = [[1.5, 8.5, 5], [5.75, 5.5, 8], [10, 2.5, 11]].map(([x, y, h], i) =>
      `<rect x="${x}" y="${y}" width="2.5" height="${h}" rx="1" fill="currentColor"${i < filled ? '' : ' opacity=".3"'}/>`).join('');
  }
  return html`<svg class="${cx('w-linear-priority-glyph', className)}" data-priority="${p}" width="${size}" height="${size}" viewBox="0 0 14 14" aria-hidden="true" focusable="false">${raw(inner)}</svg>`;
}

/** Round avatar: initials tile under the person's Linear photo (when there is one). */
export function personAvatar(person, { size = 18, className } = {}) {
  if (!person) {
    return html`<span class="${cx('w-linear-avatar', 'is-empty', className)}" style="--size:${size}px" aria-hidden="true">
      <svg width="${size}" height="${size}" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7.5" fill="none" stroke="currentColor" stroke-width="1.25" stroke-dasharray="2 2"/></svg></span>`;
  }
  const src = safeSrc(person.avatarUrl);
  return html`<span class="${cx('w-linear-avatar', className)}" style="--size:${size}px" aria-hidden="true">${avatarTile({ label: person.fullName || person.name, size, round: true, color: hueFor(person.id || person.name) })}${src
    ? html`<img src="${src}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable="false">` : ''}</span>`;
}

const HUES = ['indigo', 'violet', 'blue', 'teal', 'green', 'amber', 'orange', 'pink', 'cyan'];
function hueFor(seed = '') {
  let hash = 0;
  for (const ch of String(seed)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[hash % HUES.length];
}

export const statusIconName = type => `linear-${stateTypeOf(type).type}`;
export const priorityIconName = priority => `linear-priority-${priorityOf(priority).value}`;

// Tagged-template HTML with automatic escaping. Every interpolated value is escaped unless it is
// already a fragment produced by html``/raw(); arrays are joined; null, undefined and booleans render nothing.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ESC[c]);

class Fragment {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}
export const raw = value => value instanceof Fragment ? value : new Fragment(String(value ?? ''));
export const isFragment = value => value instanceof Fragment;
const flatten = value => value == null || value === false || value === true ? ''
  : value instanceof Fragment ? value.value
  : Array.isArray(value) ? value.map(flatten).join('')
  : esc(value);

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += flatten(values[i]) + strings[i + 1];
  return new Fragment(out);
}

/** Joins truthy class names: cx('row', active && 'is-active', ['a', false]) -> 'row is-active a'. */
export const cx = (...parts) => parts.flat(Infinity).filter(Boolean).join(' ');

/** Renders an attribute map: attrs({ 'aria-pressed': true, title: 'x', hidden: false }) -> aria-pressed="true" title="x". */
export const attrs = map => raw(Object.entries(map)
  .filter(([, v]) => v != null && v !== false)
  .map(([k, v]) => v === true && !k.startsWith('aria-') ? k : `${k}="${esc(v === true ? 'true' : v)}"`)
  .join(' '));

/** Only http(s), mailto, chrome-extension and same-document URLs survive; everything else becomes '#'. */
export function safeHref(value) {
  const text = String(value ?? '').trim();
  if (!text) return '#';
  if (/^(#|\/|\.\/|\?)/.test(text)) return text;
  try {
    const url = new URL(text);
    return ['http:', 'https:', 'mailto:', 'chrome-extension:'].includes(url.protocol) ? url.href : '#';
  } catch { return '#'; }
}

/** Image sources: http(s), data:image, blob: and packaged relative paths. */
export function safeSrc(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml);/i.test(text) || /^blob:/i.test(text)) return text;
  if (/^(assets|icons|images)\/[\w./ -]+$/i.test(text) && !text.includes('..')) return text;
  try { const url = new URL(text); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}

export const plural = (count, one, many = one + 's') => `${count.toLocaleString()} ${count === 1 ? one : many}`;

// Paints the cached appearance before first paint (a blocking classic script in <head>): skin, color mode, accent,
// density, font size, radius, motion, transparency, sidebar width and the wallpaper layer. app.js applies the live
// settings once the library loads (ui/appearance.js computes the snapshot cached in localStorage; keep both in step).
(() => {
  const root = document.documentElement;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('still.appearance.v1') || '{}') || {}; } catch {}
  // Older caches held only { theme, accent, density }.
  const attrs = saved.attrs && typeof saved.attrs === 'object' ? saved.attrs : { 'data-accent': saved.accent, 'data-density': saved.density };
  const word = value => typeof value === 'string' && /^[a-z][a-z-]{0,23}$/.test(value);
  const set = (name, fallback) => root.setAttribute(name, word(attrs[name]) ? attrs[name] : fallback);
  set('data-skin', 'still');
  // Single-mode skins paint their own mode whatever the cached preference says.
  const forced = { white: 'light', midnight: 'dark' }[root.getAttribute('data-skin')];
  const mode = forced || saved.theme;
  root.dataset.theme = mode === 'dark' || mode === 'light' ? mode : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  set('data-accent', 'blue');
  if (root.dataset.accent === 'violet') root.dataset.accent = 'blue';
  set('data-density', 'comfortable');
  set('data-font-size', 'md');
  set('data-radius', 'default');
  set('data-motion', 'system');
  set('data-transparency', 'full');
  set('data-sidebar-width', 'default');
  set('data-wallpaper', 'off');
  set('data-wallpaper-scope', 'dashboard');
  root.dataset.surface = new URLSearchParams(location.search).get('view') === 'sidepanel' ? 'side' : 'full';
  const wallpaper = saved.wallpaper && typeof saved.wallpaper === 'object' ? saved.wallpaper : {};
  if (root.dataset.wallpaper !== 'on') return;
  const image = root.dataset.theme === 'dark' ? wallpaper.dark : wallpaper.light;
  // Uploaded images are not cached (app.js resolves them from IndexedDB a moment later).
  if (typeof image === 'string' && image) root.style.setProperty('--wallpaper-image', image);
  root.style.setProperty('--wallpaper-dim', String(Math.min(0.8, Math.max(0, Number(wallpaper.dim) || 0))));
  root.style.setProperty('--wallpaper-blur', `${Math.min(40, Math.max(0, Number(wallpaper.blur) || 0))}px`);
})();

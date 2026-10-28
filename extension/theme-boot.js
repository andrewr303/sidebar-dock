// Applies the cached theme, accent and density before first paint (loaded as a blocking script in <head>).
(() => {
  const root = document.documentElement;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('still.appearance.v1') || '{}') || {}; } catch {}
  const theme = saved.theme === 'dark' || saved.theme === 'light' ? saved.theme
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.dataset.theme = theme;
  root.dataset.accent = saved.accent || 'blue';
  root.dataset.density = saved.density || 'comfortable';
  if (new URLSearchParams(location.search).get('view') === 'sidepanel') root.dataset.surface = 'side';
  else root.dataset.surface = 'full';
})();

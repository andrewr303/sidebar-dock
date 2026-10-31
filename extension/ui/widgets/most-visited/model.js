// Most visited widget model: config limits and the sites to show from chrome.topSites.get() — web pages only, minus
// the ones hidden from the widget, at most `count`. Pure: no DOM, no chrome.*.

export const COUNT_OPTIONS = Object.freeze([4, 6, 8, 10, 12, 16, 20]);
export const MOST_VISITED_VIEWS = Object.freeze(['tiles', 'list']);
const OPEN_IN = ['current', 'new', 'background'];

export const mostVisitedDefaults = () => ({ view: 'tiles', count: 8, hidden: [], openIn: 'current' });

/** A hidden-site key: the address without "www.", fragment and trailing slash, so small spelling changes still match. */
export function siteKey(url) {
  try {
    const parsed = new URL(String(url));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return `${parsed.hostname.replace(/^www\./, '').toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch { return ''; }
}

export function mostVisitedConfig(config = {}) {
  const c = { ...mostVisitedDefaults(), ...(config && typeof config === 'object' ? config : {}) };
  const count = Math.round(Number(c.count));
  return {
    view: MOST_VISITED_VIEWS.includes(c.view) ? c.view : 'tiles',
    count: Number.isFinite(count) ? Math.min(20, Math.max(1, count)) : 8,
    hidden: [...new Set((Array.isArray(c.hidden) ? c.hidden : []).map(siteKey).filter(Boolean))].slice(0, 200),
    openIn: OPEN_IN.includes(c.openIn) ? c.openIn : 'current',
  };
}

/** A site's label: its title (Chrome sometimes stores the address as the title), else the host. */
export function siteLabel(site) {
  const title = String(site?.title || '').trim();
  const host = (() => { try { return new URL(site.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  if (!title || /^https?:\/\//i.test(title)) return host || String(site?.url || '');
  return title;
}

/** Normalized top sites ([{ url, title }]), web pages only, each address once. */
export function cleanSites(list = []) {
  const seen = new Set();
  const out = [];
  for (const site of Array.isArray(list) ? list : []) {
    const key = siteKey(site?.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ url: String(site.url), title: String(site.title || '').slice(0, 300) });
  }
  return out;
}

/** The sites to draw: not hidden, at most config.count. Returns { sites, hiddenCount } (hidden ones present in the list). */
export function visibleSites(list, config) {
  const hidden = new Set(config.hidden);
  const all = cleanSites(list);
  const shown = all.filter(site => !hidden.has(siteKey(site.url)));
  return { sites: shown.slice(0, config.count), hiddenCount: all.length - shown.length };
}

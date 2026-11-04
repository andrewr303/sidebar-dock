// Website widget: turns the address a person pastes into the address that embeds well. Share and watch links of known
// services (YouTube, Vimeo, Spotify, Google Docs…) become their official player or preview pages, which allow framing;
// anything else is embedded as is. Pure: no DOM, no chrome.*, so tests run it in Node.
//
// resolveEmbed(input, { parent }) -> null for anything that is not an http(s) page, else
// { provider, label, icon, url (the page to open in a tab), embedUrl, host (of embedUrl), sourceHost, known,
//   aspect ('16:9' for players, else ''), poster, minWidth, minHeight, upgraded (http was upgraded to https),
//   referrer (the player refuses to play without a Referer header, which Chrome never sends from extension pages),
//   access (host patterns Still needs before it may add that header) }

const YOUTUBE_ID = /^[\w-]{11}$/;

/** Display data per provider: label and an icon name from ui/icons.js (embed.js registers the brand glyphs). */
export const PROVIDERS = Object.freeze({
  youtube: { label: 'YouTube', icon: 'youtube' },
  vimeo: { label: 'Vimeo', icon: 'video' },
  loom: { label: 'Loom', icon: 'video' },
  twitch: { label: 'Twitch', icon: 'twitch' },
  spotify: { label: 'Spotify', icon: 'music' },
  'apple-music': { label: 'Apple Music', icon: 'music-2' },
  soundcloud: { label: 'SoundCloud', icon: 'audio-lines' },
  figma: { label: 'Figma', icon: 'figma' },
  'google-docs': { label: 'Google Docs', icon: 'file-text' },
  'google-sheets': { label: 'Google Sheets', icon: 'table' },
  'google-slides': { label: 'Google Slides', icon: 'presentation' },
  'google-forms': { label: 'Google Forms', icon: 'list-checks' },
  'google-drive': { label: 'Google Drive', icon: 'file' },
  'google-calendar': { label: 'Google Calendar', icon: 'calendar' },
  'google-maps': { label: 'Google Maps', icon: 'map' },
  codepen: { label: 'CodePen', icon: 'codepen' },
  codesandbox: { label: 'CodeSandbox', icon: 'box' },
  miro: { label: 'Miro', icon: 'shapes' },
  airtable: { label: 'Airtable', icon: 'table' },
  web: { label: 'Website', icon: 'globe' },
});

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|[\w-]+\.localhost)$/i;
/** True for hosts a secure page may still load over http (the loopback addresses). */
export const isLocalHost = host => LOCAL_HOST.test(String(host || ''));

/**
 * A typed or pasted address as a URL object, or null. Bare domains get https; http stays http only for local hosts
 * (Chrome blocks http frames inside a secure page), other http addresses are upgraded and flagged.
 */
export function coerceUrl(input) {
  let text = String(input ?? '').trim();
  if (!text || /\s/.test(text)) return null;
  if (text.startsWith('//')) text = `https:${text}`;
  else if (!/^[a-z][a-z\d+.-]*:/i.test(text) || /^(localhost|[\w.-]+):\d+(?:[/?#]|$)/i.test(text)) {
    // "example.com/path", "localhost:3000", "192.168.1.4:8080": a host with a dot or a port, never a bare word.
    if (!/^(?:[\w-]+\.)+[\w-]{2,}(?::\d+)?(?:[/?#]|$)/.test(text) && !/^[\w.-]+:\d+(?:[/?#]|$)/.test(text) && !/^localhost(?:[/?#]|$)/i.test(text)) return null;
    text = `${isLocalHost(text.split(/[/:?#]/)[0]) ? 'http' : 'https'}://${text}`;
  }
  let url;
  try { url = new URL(text); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
  return url;
}

const strip = host => host.replace(/^(?:www|m)\./, '');
const embed = (provider, input, embedUrl, extra = {}) => {
  const target = new URL(embedUrl);
  return { provider, ...PROVIDERS[provider], url: input.href, embedUrl: target.href, host: target.hostname, sourceHost: input.hostname, known: provider !== 'web',
    aspect: '', poster: '', minWidth: 0, minHeight: 0, referrer: false, access: [], ...extra };
};

/** "90", "90s", "1m30s", "1h2m3s" -> seconds (or 0). */
export function parseStart(value) {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(text);
  if (!match || !text) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

// YouTube's player shows "Error 153" without a Referer header and needs at least 200 × 200 pixels.
export const YOUTUBE_ACCESS = Object.freeze(['https://*.youtube.com/*']);
const YOUTUBE_PLAYER = { minWidth: 200, minHeight: 200, referrer: true, access: YOUTUBE_ACCESS };

function youtube(url) {
  const host = strip(url.hostname);
  if (!['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'music.youtube.com'].includes(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  let id = '';
  if (host === 'youtu.be') id = parts[0] || '';
  else if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
  else if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1] || '';
  const list = url.searchParams.get('list') || '';
  const start = parseStart(url.searchParams.get('start') ?? url.searchParams.get('t'));
  if (YOUTUBE_ID.test(id)) {
    const player = new URL(`https://www.youtube.com/embed/${id}`);
    if (list) player.searchParams.set('list', list);
    if (start) player.searchParams.set('start', String(start));
    player.searchParams.set('rel', '0');
    const watch = new URL('https://www.youtube.com/watch');
    watch.searchParams.set('v', id);
    if (list) watch.searchParams.set('list', list);
    if (start) watch.searchParams.set('t', `${start}s`);
    return { ...embed('youtube', url, player.href, { ...YOUTUBE_PLAYER, aspect: parts[0] === 'shorts' ? '9:16' : '16:9', poster: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }), url: watch.href };
  }
  if (list) {
    const player = new URL('https://www.youtube.com/embed/videoseries');
    player.searchParams.set('list', list);
    return { ...embed('youtube', url, player.href, { ...YOUTUBE_PLAYER, aspect: '16:9' }), url: `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}` };
  }
  return null;
}

function vimeo(url) {
  const host = strip(url.hostname);
  if (host === 'vimeo.com') {
    const match = /^\/(?:channels\/[^/]+\/|groups\/[^/]+\/videos\/|showcase\/\d+\/video\/)?(\d+)(?:\/([\da-f]+))?/i.exec(url.pathname);
    if (!match) return null;
    const hash = match[2] || url.searchParams.get('h') || '';
    return embed('vimeo', url, `https://player.vimeo.com/video/${match[1]}${hash ? `?h=${hash}` : ''}`, { aspect: '16:9' });
  }
  if (host === 'player.vimeo.com' && /^\/video\/\d+/.test(url.pathname)) return embed('vimeo', url, url.href, { aspect: '16:9' });
  return null;
}

function loom(url) {
  if (strip(url.hostname) !== 'loom.com') return null;
  const match = /^\/(?:share|embed)\/([\da-f]{24,40})/i.exec(url.pathname);
  return match ? embed('loom', url, `https://www.loom.com/embed/${match[1]}`, { aspect: '16:9' }) : null;
}

function twitch(url, { parent }) {
  const host = strip(url.hostname);
  const parentParam = `parent=${encodeURIComponent(parent || 'localhost')}`;
  if (host === 'clips.twitch.tv') {
    const slug = url.pathname.split('/').filter(Boolean)[0];
    return slug && slug !== 'embed' ? embed('twitch', url, `https://clips.twitch.tv/embed?clip=${encodeURIComponent(slug)}&${parentParam}`, { aspect: '16:9' }) : null;
  }
  if (host !== 'twitch.tv') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'videos' && /^\d+$/.test(parts[1] || '')) return embed('twitch', url, `https://player.twitch.tv/?video=v${parts[1]}&${parentParam}`, { aspect: '16:9' });
  if (parts[1] === 'clip' && parts[2]) return embed('twitch', url, `https://clips.twitch.tv/embed?clip=${encodeURIComponent(parts[2])}&${parentParam}`, { aspect: '16:9' });
  if (parts.length === 1 && /^\w{3,25}$/.test(parts[0]) && !['directory', 'downloads', 'jobs', 'p', 'settings', 'subscriptions', 'turbo', 'videos'].includes(parts[0])) {
    return embed('twitch', url, `https://player.twitch.tv/?channel=${encodeURIComponent(parts[0].toLowerCase())}&${parentParam}`, { aspect: '16:9' });
  }
  return null;
}

function spotify(url) {
  if (url.hostname !== 'open.spotify.com') return null;
  const match = /^\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z\d]+)/.exec(url.pathname);
  return match ? embed('spotify', url, `https://open.spotify.com/embed/${match[1]}/${match[2]}`) : null;
}

function appleMusic(url) {
  if (!['music.apple.com', 'podcasts.apple.com', 'embed.music.apple.com', 'embed.podcasts.apple.com'].includes(url.hostname)) return null;
  if (url.pathname.split('/').filter(Boolean).length < 2) return null;
  const target = new URL(url.href);
  target.hostname = url.hostname.startsWith('embed.') ? url.hostname : `embed.${url.hostname}`;
  return embed('apple-music', url, target.href);
}

function soundcloud(url) {
  if (strip(url.hostname) !== 'soundcloud.com' || url.pathname.split('/').filter(Boolean).length < 1) return null;
  return embed('soundcloud', url, `https://w.soundcloud.com/player/?url=${encodeURIComponent(url.href)}&visual=true`);
}

function figma(url) {
  if (strip(url.hostname) !== 'figma.com') return null;
  if (url.pathname === '/embed' && url.searchParams.get('url')) return embed('figma', url, url.href);
  if (!/^\/(file|design|proto|board|slides)\//.test(url.pathname)) return null;
  return embed('figma', url, `https://www.figma.com/embed?embed_host=still&url=${encodeURIComponent(url.href)}`);
}

function decodeCalendarId(value) {
  try {
    const text = globalThis.atob(String(value).replace(/-/g, '+').replace(/_/g, '/'));
    return /^[^\s@]+@[^\s@]+$/.test(text) ? text : '';
  } catch { return ''; }
}

/** decodeURIComponent that keeps text with a stray "%" as it is instead of throwing. */
function decodePart(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function google(url) {
  const host = url.hostname;
  if (host === 'docs.google.com') {
    const kinds = { document: 'google-docs', spreadsheets: 'google-sheets', presentation: 'google-slides', forms: 'google-forms' };
    const kind = url.pathname.split('/')[1];
    const provider = kinds[kind];
    if (!provider) return null;
    const published = /^\/(document|spreadsheets|presentation|forms)\/d\/e\/([^/]+)\/(\w+)/.exec(url.pathname);
    if (published) {
      const [, , id, page] = published;
      if (kind === 'presentation') return embed(provider, url, `https://docs.google.com/presentation/d/e/${id}/embed${url.search}`, { aspect: '16:9' });
      if (kind === 'forms') return embed(provider, url, `https://docs.google.com/forms/d/e/${id}/viewform?embedded=true`);
      const target = new URL(`https://docs.google.com/${kind}/d/e/${id}/${page === 'pubhtml' || page === 'pub' ? page : kind === 'spreadsheets' ? 'pubhtml' : 'pub'}`);
      url.searchParams.forEach((value, key) => target.searchParams.set(key, value));
      if (kind === 'document') target.searchParams.set('embedded', 'true');
      if (kind === 'spreadsheets') { if (!target.searchParams.has('widget')) target.searchParams.set('widget', 'true'); if (!target.searchParams.has('headers')) target.searchParams.set('headers', 'false'); }
      return embed(provider, url, target.href);
    }
    const file = /^\/(document|spreadsheets|presentation|forms)\/d\/([^/]+)/.exec(url.pathname);
    if (!file) return null;
    if (kind === 'forms') return embed(provider, url, `https://docs.google.com/forms/d/${file[2]}/viewform?embedded=true`);
    return embed(provider, url, `https://docs.google.com/${kind}/d/${file[2]}/preview`, kind === 'presentation' ? { aspect: '16:9' } : {});
  }
  if (host === 'drive.google.com') {
    const match = /^\/file\/d\/([^/]+)/.exec(url.pathname) || (url.pathname === '/open' && url.searchParams.get('id') ? [null, url.searchParams.get('id')] : null);
    return match ? embed('google-drive', url, `https://drive.google.com/file/d/${match[1]}/preview`) : null;
  }
  if (host === 'calendar.google.com') {
    if (url.pathname.startsWith('/calendar/embed')) return embed('google-calendar', url, url.href);
    const src = url.searchParams.get('src') || decodeCalendarId(url.searchParams.get('cid'));
    return src ? embed('google-calendar', url, `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(src)}`) : null;
  }
  const maps = (host === 'maps.google.com' || /^(?:www\.)?google\.[a-z.]+$/.test(host)) && (host === 'maps.google.com' || url.pathname.startsWith('/maps'));
  if (maps) {
    if (url.pathname.startsWith('/maps/embed') || url.searchParams.get('output') === 'embed') return embed('google-maps', url, url.href);
    const target = new URL('https://maps.google.com/maps');
    const place = /^\/maps\/(?:place|search)\/([^/]+)/.exec(url.pathname);
    const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)z)?/.exec(url.pathname);
    const query = url.searchParams.get('q') || url.searchParams.get('query') || (place ? decodePart(place[1].replace(/\+/g, ' ')) : '');
    if (query) target.searchParams.set('q', query);
    else if (at) target.searchParams.set('ll', `${at[1]},${at[2]}`);
    else return null;
    if (at?.[3]) target.searchParams.set('z', String(Math.round(Number(at[3]))));
    target.searchParams.set('output', 'embed');
    return embed('google-maps', url, target.href);
  }
  return null;
}

function codepen(url) {
  if (strip(url.hostname) !== 'codepen.io') return null;
  const match = /^\/([^/]+)\/(?:pen|full|details|embed)\/([^/?#]+)/.exec(url.pathname);
  return match ? embed('codepen', url, `https://codepen.io/${match[1]}/embed/${match[2]}?default-tab=result`) : null;
}

function codesandbox(url) {
  if (strip(url.hostname) !== 'codesandbox.io') return null;
  const match = /^\/(?:s|embed|p\/sandbox|p\/devbox)\/([^/?#]+)/.exec(url.pathname);
  return match ? embed('codesandbox', url, `https://codesandbox.io/embed/${match[1]}`) : null;
}

function miro(url) {
  if (strip(url.hostname) !== 'miro.com') return null;
  const match = /^\/app\/(?:board|live-embed)\/([^/?#]+)/.exec(url.pathname);
  return match ? embed('miro', url, `https://miro.com/app/live-embed/${match[1]}/`) : null;
}

function airtable(url) {
  if (strip(url.hostname) !== 'airtable.com') return null;
  const path = url.pathname.replace(/^\/embed/, '');
  if (!/\/shr\w+/.test(path)) return null;
  return embed('airtable', url, `https://airtable.com/embed${path}`);
}

const RESOLVERS = [youtube, vimeo, loom, twitch, spotify, appleMusic, soundcloud, figma, google, codepen, codesandbox, miro, airtable];

/** The embed target for a typed address (see the header). `parent` is the embedding host for services that ask for it (Twitch). */
export function resolveEmbed(input, { parent = '' } = {}) {
  const url = coerceUrl(input);
  if (!url) return null;
  let upgraded = false;
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) { url.protocol = 'https:'; upgraded = true; }
  for (const resolve of RESOLVERS) {
    const found = resolve(url, { parent });
    if (found) return { ...found, upgraded };
  }
  return { ...embed('web', url, url.href), upgraded };
}

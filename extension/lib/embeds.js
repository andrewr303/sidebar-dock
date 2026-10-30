// Live embeds for notes. describeEmbed(url) turns a pasted address into what the editor frames: well-known share
// links become their providers' embed players (YouTube, Vimeo, Loom, Figma, Google Docs/Sheets/Slides/Forms/Drive/
// Maps, CodePen, CodeSandbox, Spotify, X, Miro, Airtable), PDFs open in the browser's viewer and anything else is
// framed as a web page. Pure and Node-importable; the block editor owns the frames.
//
// Sites can refuse to be framed (X-Frame-Options or a CSP frame-ancestors rule). The browser then shows its own error
// page inside the frame, so every embed keeps an "Open" link to the original address.

export const EMBED_HEIGHTS = Object.freeze({ small: 320, medium: 480, large: 720 });
export const MIN_EMBED_HEIGHT = 120;
export const MAX_EMBED_HEIGHT = 2000;

const KIND_LABELS = { video: 'Video', audio: 'Audio', pdf: 'PDF', doc: 'Document', design: 'Design', code: 'Code', social: 'Post', map: 'Map', form: 'Form', site: 'Website' };

/** http(s) only, no credentials; returns the normalized href or ''. */
export function embedUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /[\u0000-\u0020\u007f]/.test(raw)) return '';
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname.includes('.') && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

const seconds = value => {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  return m ? (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0) : 0;
};
const segment = (path, index) => path.split('/').filter(Boolean)[index] || '';

const RULES = [
  (url, host) => {
    let id = '';
    if (host === 'youtu.be') id = segment(url.pathname, 0);
    else if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
      const [first, second] = url.pathname.split('/').filter(Boolean);
      id = first === 'watch' ? url.searchParams.get('v') || '' : ['shorts', 'live', 'embed', 'v'].includes(first) ? second || '' : '';
      const list = url.searchParams.get('list');
      if (!id && list && /^[\w-]+$/.test(list)) return { kind: 'video', provider: 'YouTube', src: `https://www.youtube-nocookie.com/embed/videoseries?list=${list}`, label: 'YouTube playlist' };
    } else return null;
    if (!/^[\w-]{6,20}$/.test(id)) return null;
    const start = seconds(url.searchParams.get('t') || url.searchParams.get('start') || '');
    return { kind: 'video', provider: 'YouTube', src: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`, label: 'YouTube video' };
  },
  (url, host) => {
    if (host !== 'vimeo.com' && host !== 'player.vimeo.com') return null;
    const m = /(?:^|\/)(?:video\/)?(\d{5,12})(?:\/([\da-f]{6,20}))?/.exec(url.pathname);
    if (!m) return null;
    const hash = m[2] || url.searchParams.get('h');
    return { kind: 'video', provider: 'Vimeo', src: `https://player.vimeo.com/video/${m[1]}${hash ? `?h=${hash}` : ''}`, label: 'Vimeo video' };
  },
  (url, host) => {
    const m = host === 'loom.com' && /^\/(?:share|embed)\/([\da-f]{16,64})/.exec(url.pathname);
    return m ? { kind: 'video', provider: 'Loom', src: `https://www.loom.com/embed/${m[1]}`, label: 'Loom video' } : null;
  },
  (url, host) => {
    if (!/(^|\.)figma\.com$/.test(host) || !/^\/(file|design|proto|board|slides|deck)\//.test(url.pathname)) return null;
    return { kind: 'design', provider: 'Figma', src: `https://www.figma.com/embed?embed_host=still&url=${encodeURIComponent(url.href)}`, label: 'Figma file', height: 560 };
  },
  (url, host) => {
    if (host !== 'docs.google.com') return null;
    const m = /^\/(document|spreadsheets|presentation|forms)\/d\/(e\/)?([\w-]{10,})/.exec(url.pathname);
    if (!m) return null;
    const [, type, published, id] = m;
    const base = `https://docs.google.com/${type}/d/${published || ''}${id}`;
    if (type === 'forms') return { kind: 'form', provider: 'Google Forms', src: `${base}/viewform?embedded=true`, label: 'Google Form', height: 720 };
    if (published) return { kind: 'doc', provider: 'Google Docs', src: `${base}/${type === 'presentation' ? 'embed' : 'pubhtml'}?widget=true`, label: 'Google document', height: 640 };
    const names = { document: ['Google Docs', 'Google Doc'], spreadsheets: ['Google Sheets', 'Google Sheet'], presentation: ['Google Slides', 'Google Slides deck'] };
    return { kind: 'doc', provider: names[type][0], src: `${base}/${type === 'presentation' ? 'embed' : 'preview'}`, label: names[type][1], height: type === 'presentation' ? 0 : 640, aspect: type === 'presentation' ? '16 / 9' : '' };
  },
  (url, host) => {
    const m = host === 'drive.google.com' && /^\/file\/d\/([\w-]{10,})/.exec(url.pathname);
    return m ? { kind: 'doc', provider: 'Google Drive', src: `https://drive.google.com/file/d/${m[1]}/preview`, label: 'Google Drive file', height: 640 } : null;
  },
  (url, host) => {
    if (!/^(www\.)?google\.[a-z.]+$|^maps\.google\.[a-z.]+$/.test(host) || !url.pathname.startsWith('/maps')) return null;
    const place = /^\/maps\/(?:place|search)\/([^/]+)/.exec(url.pathname)?.[1];
    const query = url.searchParams.get('q') || (place ? decodeURIComponent(place.replace(/\+/g, ' ')) : '');
    return query ? { kind: 'map', provider: 'Google Maps', src: `https://maps.google.com/maps?q=${encodeURIComponent(query)}&output=embed`, label: query, height: 400 } : null;
  },
  (url, host) => {
    const m = host === 'codepen.io' && /^\/([\w-]+)\/(?:pen|embed|full|details)\/([\w-]+)/.exec(url.pathname);
    return m ? { kind: 'code', provider: 'CodePen', src: `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result`, label: 'CodePen', height: 480 } : null;
  },
  (url, host) => {
    const m = host === 'codesandbox.io' && /^\/(?:s|p\/sandbox|embed)\/([\w-]+)/.exec(url.pathname);
    return m ? { kind: 'code', provider: 'CodeSandbox', src: `https://codesandbox.io/embed/${m[1]}`, label: 'CodeSandbox', height: 560 } : null;
  },
  (url, host) => {
    const m = host === 'open.spotify.com' && /^\/(?:intl-[\w-]+\/)?(?:embed\/)?(track|album|playlist|episode|show|artist)\/([\w]+)/.exec(url.pathname);
    return m ? { kind: 'audio', provider: 'Spotify', src: `https://open.spotify.com/embed/${m[1]}/${m[2]}`, label: `Spotify ${m[1]}`, height: ['track', 'episode'].includes(m[1]) ? 152 : 352 } : null;
  },
  (url, host) => {
    const m = /^(mobile\.)?(twitter|x)\.com$/.test(host) && /^\/[\w]+\/status(?:es)?\/(\d{5,25})/.exec(url.pathname);
    return m ? { kind: 'social', provider: 'X', src: `https://platform.twitter.com/embed/Tweet.html?id=${m[1]}`, label: 'Post on X', height: 560 } : null;
  },
  (url, host) => {
    const m = host === 'miro.com' && /^\/app\/(?:board|live-embed)\/([\w=-]+)/.exec(url.pathname);
    return m ? { kind: 'design', provider: 'Miro', src: `https://miro.com/app/live-embed/${m[1]}/`, label: 'Miro board', height: 560 } : null;
  },
  (url, host) => {
    const m = host === 'airtable.com' && /^\/(?:embed\/)?((?:app\w+\/)?shr\w+)/.exec(url.pathname);
    return m ? { kind: 'doc', provider: 'Airtable', src: `https://airtable.com/embed/${m[1]}`, label: 'Airtable view', height: 560 } : null;
  },
];

/**
 * describeEmbed(url) -> null | { url, src, kind, provider, label, host, height, aspect, sandbox }
 * src is '' when the address cannot be framed here (plain http pages would be blocked as mixed content).
 * sandbox is false only for PDFs: Chrome does not run its PDF viewer inside sandboxed frames.
 */
export function describeEmbed(input) {
  const href = embedUrl(input);
  if (!href) return null;
  const url = new URL(href);
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  for (const rule of RULES) {
    const hit = rule(url, host);
    if (hit) return { url: href, host, height: hit.kind === 'video' ? 0 : 480, aspect: hit.kind === 'video' ? '16 / 9' : '', sandbox: true, ...hit };
  }
  const pdf = /\.pdf$/i.test(url.pathname);
  return {
    url: href, host, src: url.protocol === 'https:' ? href : '', kind: pdf ? 'pdf' : 'site', provider: pdf ? 'PDF' : host,
    label: pdf ? decodeURIComponent(url.pathname.split('/').pop() || 'PDF') : host + (url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : ''),
    height: pdf ? 720 : 480, aspect: '', sandbox: !pdf,
  };
}

export const embedKindLabel = kind => KIND_LABELS[kind] || KIND_LABELS.site;

/** The next size in the small → medium → large cycle for an embed's current height. */
export function nextEmbedHeight(current, fallback = EMBED_HEIGHTS.medium) {
  const value = Number(current) || fallback;
  const sizes = Object.values(EMBED_HEIGHTS);
  return sizes.find(size => size > value + 8) || sizes[0];
}
export const clampEmbedHeight = value => Math.max(MIN_EMBED_HEIGHT, Math.min(MAX_EMBED_HEIGHT, Math.round(Number(value) || 0)));

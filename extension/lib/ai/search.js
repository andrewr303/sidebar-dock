// Library search: BM25-style lexical ranking (honouring the store.queryItems syntax: tag:x, #x, type:x and "quoted
// phrases"), cosine similarity over embedded chunks, and hybrid ranking by reciprocal-rank fusion. When the semantic
// index is off or a query cannot be embedded, every mode degrades to lexical results.
import { getDescendantCollectionIds } from '../library-views.js';

const text = value => typeof value === 'string' ? value : '';
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const SCRIPT_RUNS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const STOP_WORDS = new Set(('a an and are as at be but by can do does for from has have how i in into is it its me my of on or our so than that the their them '
  + 'then there these they this to was we what when where which who why will with you your about all any some find show give tell please').split(' '));
export const isStopWord = token => STOP_WORDS.has(token);
const URL_NOISE = new Set(['http', 'https', 'www', 'com', 'org', 'net', 'html', 'htm', 'php']);
// [field, weight, length normalization b]
const FIELDS = [['title', 4, 0.3], ['tags', 3, 0], ['url', 1.5, 0.3], ['excerpt', 1.5, 0.75], ['highlights', 2, 0.75], ['content', 1.2, 0.75], ['article', 1, 0.75]];
const PREFIX_FIELDS = ['title', 'tags', 'url'];
/** How much of a captured article takes part in keyword scoring. */
export const ARTICLE_SCORED = 60_000;
const K1 = 1.2;

const foldPlural = token => {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !/(?:ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
};
const foldCase = value => { const lower = value.toLowerCase(); return /[^\x00-\x7f]/.test(lower) ? lower.normalize('NFKD').replace(/\p{M}+/gu, '') : lower; };
export const normalizeToken = raw => foldPlural(foldCase(String(raw)));

/** Word tokens (lowercased, accent-folded, light plural folding); CJK runs become overlapping bigrams. */
export function tokenize(value) {
  const source = foldCase(String(value ?? ''));
  const tokens = [];
  if (!/[^\x00-\x7f]/.test(source)) {
    // ASCII fast path (most saved text): a character scan is several times faster than a Unicode regex.
    let start = -1;
    for (let i = 0; i <= source.length; i++) {
      const code = i < source.length ? source.charCodeAt(i) : 0;
      const word = (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
      if (word && start < 0) start = i;
      else if (!word && start >= 0) { tokens.push(foldPlural(source.slice(start, i))); start = -1; }
    }
    return tokens;
  }
  for (const [word] of source.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (!CJK.test(word)) { tokens.push(foldPlural(word)); continue; }
    for (const [run] of word.matchAll(SCRIPT_RUNS)) {
      if (!CJK.test(run)) { tokens.push(foldPlural(run)); continue; }
      const chars = [...run];
      if (chars.length === 1) tokens.push(run);
      for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
    }
  }
  return tokens;
}

const OPERATORS = /(?:^|\s)(?:tag:|#|type:)[^\s]+/gi;

/**
 * Splits a query into the store.queryItems filters (tags, type, phrases) and free terms.
 * operators: false reads the whole text as words. A question a person asks ("what did issue #42 decide?", a sentence
 * with a quotation in it) is not a filter expression; read as one, it would require a tag named 42.
 * semanticText keeps the query's own casing: an embedding model reads "Apple" and "apple" differently.
 */
export function parseQuery(query, { operators = true } = {}) {
  const original = text(query).trim();
  let rest = original.toLowerCase();
  if (!operators) {
    const loose = rest.replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim();
    const all = tokenize(loose);
    const meaningful = all.filter(token => !STOP_WORDS.has(token));
    return { tags: [], type: '', phrases: [], terms: [...new Set(meaningful.length ? meaningful : all)], words: (loose ? loose.split(' ') : []).filter(word => !STOP_WORDS.has(word)),
      semanticText: original.replace(/\s+/g, ' ') };
  }
  const tags = [...rest.matchAll(/(?:^|\s)(?:tag:|#)([^\s]+)/g)].map(match => match[1]);
  const type = rest.match(/(?:^|\s)type:([^\s]+)/)?.[1] || '';
  rest = rest.replace(/(?:^|\s)(?:tag:|#|type:)[^\s]+/g, ' ');
  const phrases = [...rest.matchAll(/"([^"]+)"/g)].map(match => match[1].trim()).filter(Boolean);
  const loose = rest.replace(/"[^"]*"?/g, ' ').replace(/\s+/g, ' ').trim();
  const words = loose ? loose.split(' ') : [];
  const all = tokenize(loose);
  const meaningful = all.filter(token => !STOP_WORDS.has(token));
  const terms = [...new Set(meaningful.length ? meaningful : all)];
  // The same text without the operators, in the casing the person typed.
  const typed = original.replace(OPERATORS, ' ');
  const semanticText = [typed.replace(/"[^"]*"?/g, ' '), ...[...typed.matchAll(/"([^"]+)"/g)].map(match => match[1])].join(' ').replace(/\s+/g, ' ').trim();
  return { tags, type, phrases, terms, words: words.filter(word => !STOP_WORDS.has(word)), semanticText };
}

/** Light Markdown-to-text for snippets: drops markup but keeps the words. */
export function plainText(markdown) {
  return text(markdown)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function makeSnippet(source, needles = [], max = 220) {
  const value = text(source).replace(/\s+/g, ' ').trim();
  if (!value) return '';
  const clip = () => value.length <= max ? value : `${value.slice(0, value.lastIndexOf(' ', max) > max * 0.6 ? value.lastIndexOf(' ', max) : max).trim()}…`;
  const lower = value.toLowerCase();
  let at = -1;
  for (const needle of needles) {
    if (!needle) continue;
    const index = lower.indexOf(needle.toLowerCase());
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  if (at < 0 || value.length <= max || at < max * 0.6) return clip();
  let start = Math.max(0, at - Math.floor(max / 3));
  const space = value.indexOf(' ', start);
  if (space >= 0 && space < at) start = space + 1;
  let end = Math.min(value.length, start + max);
  if (end < value.length) { const cut = value.lastIndexOf(' ', end); if (cut > at) end = cut; }
  return `${start > 0 ? '…' : ''}${value.slice(start, end).trim()}${end < value.length ? '…' : ''}`;
}

function fieldTexts(item) {
  let url = '';
  try { const parsed = new URL(text(item.url) || text(item.sourceUrl)); url = `${parsed.hostname} ${parsed.pathname}`; } catch {}
  const highlights = (Array.isArray(item.highlights) ? item.highlights : []).map(h => `${text(h?.text)} ${text(h?.note)}`).join('\n');
  // An AI chat is found by its provider, project, kind of work and topics too ("claude code sessions about billing").
  const chat = item.type === 'chat' && item.chat && typeof item.chat === 'object' ? item.chat : null;
  if (chat) url = [url, text(chat.providerLabel), text(chat.provider).replace(/_/g, ' '), text(chat.project), text(chat.kindLabel) || text(chat.kind), text(chat.agentLabel),
    chat.category === 'coding_agent' ? 'coding agent session' : ''].filter(Boolean).join(' ');
  const topics = chat && Array.isArray(chat.topics) ? chat.topics.filter(topic => typeof topic === 'string') : [];
  return { title: text(item.title), tags: [...(Array.isArray(item.tags) ? item.tags : []), ...topics].join(' '), url, excerpt: text(item.excerpt),
    highlights, content: text(item.content), article: text(item.articleContent), fileName: text(item.fileName) };
}

function analyze(item) {
  const fields = fieldTexts(item);
  const tf = {};
  const len = {};
  for (const [field] of FIELDS) {
    // Long captured articles are scored on their first 60k characters; quoted phrases still match the full text.
    const source = field === 'title' ? `${fields.title} ${fields.fileName}` : field === 'article' ? fields.article.slice(0, ARTICLE_SCORED) : fields[field];
    const tokens = tokenize(source).filter(token => field !== 'url' || !URL_NOISE.has(token));
    const map = new Map();
    for (const token of tokens) map.set(token, (map.get(token) || 0) + 1);
    tf[field] = map;
    len[field] = tokens.length;
  }
  return { tf, len, fields, haystack: null };
}

/** Per-item analysis cached by updatedAt so typing a query does not re-tokenize the library. */
export function createAnalysisCache() {
  const entries = new Map();
  return {
    get(item) {
      const stamp = text(item.updatedAt);
      const cached = entries.get(item.id);
      if (cached && stamp && cached.stamp === stamp) return cached.value;
      const value = analyze(item);
      entries.set(item.id, { stamp, value });
      return value;
    },
    prune(liveIds) { for (const id of entries.keys()) if (!liveIds.has(id)) entries.delete(id); },
  };
}

const haystackOf = analysis => analysis.haystack ??= Object.values(analysis.fields).join('\n').toLowerCase();

/** A predicate for structured filters: { collectionId, includeDescendants, type, tag, favorite, archived, ids, excludeIds }. Trash never matches. */
export function itemMatcher(library, filter = {}) {
  const collectionIds = typeof filter.collectionId === 'string'
    ? new Set(filter.includeDescendants === false ? [filter.collectionId] : getDescendantCollectionIds(library, filter.collectionId)) : null;
  const ids = Array.isArray(filter.ids) ? new Set(filter.ids) : null;
  const exclude = new Set(Array.isArray(filter.excludeIds) ? filter.excludeIds : []);
  const tag = text(filter.tag).toLowerCase().replace(/^#/, '');
  return item => {
    if (!item || typeof item.id !== 'string' || item.deletedAt) return false;
    if (filter.archived === true ? !item.archived : filter.archived !== 'all' && item.archived) return false;
    if (filter.favorite === true && !item.favorite) return false;
    if (collectionIds && !collectionIds.has(text(item.collectionId))) return false;
    if (filter.type && filter.type !== 'all' && item.type !== filter.type) return false;
    if (tag && !(item.tags || []).some(t => String(t).toLowerCase() === tag)) return false;
    if (ids && !ids.has(item.id)) return false;
    return !exclude.has(item.id);
  };
}

function queryMatcher(parsed, cache) {
  return item => {
    if (parsed.type && parsed.type !== 'all' && item.type !== parsed.type) return false;
    if (parsed.tags.length) {
      const tags = (item.tags || []).map(tag => String(tag).toLowerCase());
      if (parsed.tags.some(tag => !tags.includes(tag))) return false;
    }
    if (parsed.phrases.length) {
      const haystack = haystackOf(cache.get(item));
      if (parsed.phrases.some(phrase => !haystack.includes(phrase))) return false;
    }
    return true;
  };
}

const recency = item => text(item.updatedAt) || text(item.createdAt);

function snippetFor(analysis, needles) {
  const { fields } = analysis;
  const sources = [fields.highlights, plainText(fields.content), fields.article, fields.excerpt];
  for (const source of sources) {
    const lower = source.toLowerCase();
    if (needles.some(needle => needle && lower.includes(needle))) return makeSnippet(source, needles);
  }
  return makeSnippet(fields.excerpt || plainText(fields.content) || fields.article, needles);
}

/**
 * Lexical ranking (BM25F over weighted fields with prefix matches on short fields). Returns [{ id, score, snippet }].
 * Queries with only filters (tag:, type:, phrases) return every match, newest first.
 */
export function lexicalSearch(items, query, { allow = item => !item.deletedAt && !item.archived, cache = createAnalysisCache(), limit = Infinity } = {}) {
  const parsed = typeof query === 'object' && query ? query : parseQuery(query);
  const matches = queryMatcher(parsed, cache);
  const candidates = (Array.isArray(items) ? items : []).filter(item => allow(item) && matches(item));
  const needles = [...new Set([...parsed.words, ...parsed.terms, ...parsed.phrases])].filter(needle => needle.length > 1);
  if (!parsed.terms.length) {
    return candidates.sort((a, b) => recency(b).localeCompare(recency(a)) || byId(a, b)).slice(0, limit)
      .map(item => ({ id: item.id, score: 1, snippet: snippetFor(cache.get(item), needles) }));
  }
  const analyses = candidates.map(item => ({ item, analysis: cache.get(item) }));
  const avg = {};
  for (const [field] of FIELDS) avg[field] = Math.max(1, analyses.reduce((sum, entry) => sum + entry.analysis.len[field], 0) / Math.max(1, analyses.length));
  // Pass 1: field term frequencies per candidate (exact tokens, plus prefixes on short fields for as-you-type queries).
  const df = new Map(parsed.terms.map(term => [term, 0]));
  const rows = [];
  for (const entry of analyses) {
    const perTerm = [];
    let any = false;
    for (const term of parsed.terms) {
      const freq = {};
      let hit = false;
      for (const [field] of FIELDS) {
        let count = entry.analysis.tf[field].get(term) || 0;
        if (!count && term.length >= 2 && PREFIX_FIELDS.includes(field)) {
          for (const [token, n] of entry.analysis.tf[field]) if (token.length > term.length && token.startsWith(term)) count += n * 0.6;
        }
        if (count) { freq[field] = count; hit = true; }
      }
      perTerm.push(hit ? freq : null);
      if (hit) { any = true; df.set(term, df.get(term) + 1); }
    }
    if (any) rows.push({ ...entry, perTerm });
  }
  // Pass 2: BM25F score with a coverage factor so items matching every term outrank partial matches.
  const total = Math.max(1, analyses.length);
  const wholeQuery = parsed.words.join(' ');
  const scored = rows.map(({ item, analysis, perTerm }) => {
    let score = 0;
    let matched = 0;
    parsed.terms.forEach((term, index) => {
      const freq = perTerm[index];
      if (!freq) return;
      let weighted = 0;
      for (const [field, weight, b] of FIELDS) {
        if (!freq[field]) continue;
        weighted += weight * freq[field] / (1 - b + b * analysis.len[field] / avg[field]);
      }
      const n = df.get(term);
      const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
      score += idf * (weighted * (K1 + 1)) / (weighted + K1);
      matched++;
    });
    const coverage = matched / parsed.terms.length;
    score *= 0.3 + 0.7 * coverage;
    if (parsed.words.length > 1 && analysis.fields.title.toLowerCase().includes(wholeQuery)) score *= 1.5;
    return { item, analysis, score };
  });
  return scored.sort((a, b) => b.score - a.score || recency(b.item).localeCompare(recency(a.item)) || byId(a.item, b.item))
    .slice(0, limit).map(({ item, analysis, score }) => ({ id: item.id, score: Math.round(score * 10000) / 10000, snippet: snippetFor(analysis, needles) }));
}

export function dot(a, b) {
  if (!a || !b || a.length !== b.length) return NaN;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
export function cosine(a, b) {
  const product = dot(a, b);
  if (Number.isNaN(product)) return NaN;
  const norm = Math.sqrt(dot(a, a) * dot(b, b));
  return norm ? product / norm : 0;
}

/** Mean of unit vectors, re-normalized. */
export function centroid(vectors) {
  const list = vectors.filter(vector => vector?.length);
  if (!list.length) return null;
  const out = new Float32Array(list[0].length);
  for (const vector of list) if (vector.length === out.length) for (let i = 0; i < out.length; i++) out[i] += vector[i];
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
  const norm = Math.sqrt(sum);
  if (norm) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/**
 * Item score = its best chunk's similarity to the (unit) query vector. Returns [{ id, score, chunk, next? }] best
 * first; `next` is the item's second-best chunk ({ score, chunk }), for callers that want more than one passage.
 */
export function semanticRank(queryVector, chunks, { allow = () => true } = {}) {
  const best = new Map();
  const beats = (score, chunk, other) => !other || score > other.score || (score === other.score && chunk.n < other.chunk.n);
  for (const chunk of chunks || []) {
    if (!allow(chunk.itemId)) continue;
    const score = dot(queryVector, chunk.vector);
    if (Number.isNaN(score)) continue;
    const previous = best.get(chunk.itemId);
    if (beats(score, chunk, previous)) best.set(chunk.itemId, { id: chunk.itemId, score, chunk, ...(previous ? { next: { score: previous.score, chunk: previous.chunk } } : {}) });
    else if (beats(score, chunk, previous.next)) previous.next = { score, chunk };
  }
  return [...best.values()].sort((a, b) => b.score - a.score || byId(a, b));
}

/** Reciprocal-rank fusion: score(d) = sum over lists of 1 / (k + rank). Ties break on best single rank, then id. */
export function reciprocalRankFusion(lists, { k = 60 } = {}) {
  const fused = new Map();
  lists.forEach((list, listIndex) => (list || []).forEach((entry, rank) => {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id !== 'string') return;
    const row = fused.get(id) || { id, score: 0, ranks: lists.map(() => null) };
    if (row.ranks[listIndex] !== null) return;
    row.ranks[listIndex] = rank + 1;
    row.score += 1 / (k + rank + 1);
    fused.set(id, row);
  }));
  const bestRank = row => Math.min(...row.ranks.filter(rank => rank !== null));
  return [...fused.values()].sort((a, b) => b.score - a.score || bestRank(a) - bestRank(b) || byId(a, b));
}

/** Keeps the head of a similarity list: at most `size` entries scoring within `relative` of the best. */
export function semanticHead(list, { size = 30, relative = 0.7, floor = 0.05 } = {}) {
  if (!list.length) return list;
  const minimum = Math.max(floor, list[0].score * relative);
  return list.filter(entry => entry.score >= minimum).slice(0, size);
}

/**
 * createSearch({ getLibrary, vectorStore, isSemanticReady, embedQuery }) -> { searchLibrary, relatedItems }
 * searchLibrary(query, { limit, mode: 'hybrid'|'semantic'|'lexical', filter, operators, chunks, signal })
 *   -> [{ id, score, snippet, source, title, type, url, lexicalScore?, semanticScore?, chunks? }]
 * score orders the list (in hybrid mode it is a rank fusion, so it says nothing about how good a match is);
 * lexicalScore and semanticScore are the scores of each ranking, for callers that judge relevance.
 * operators: false reads the query as a plain question (see parseQuery). chunks: n adds the texts of up to n
 * (at most 2) of the item's best-matching indexed chunks.
 */
export function createSearch({ getLibrary, vectorStore, isSemanticReady = async () => false, embedQuery } = {}) {
  const cache = createAnalysisCache();
  const queryVectors = new Map();
  const centroidCache = new WeakMap();
  let pruneStamp = '';
  let vectorStamp = '';

  async function vectorFor(query, signal) {
    if (queryVectors.has(query)) return queryVectors.get(query);
    const vector = await embedQuery(query, { signal });
    queryVectors.set(query, vector);
    if (queryVectors.size > 48) queryVectors.delete(queryVectors.keys().next().value);
    return vector;
  }
  async function semanticCandidates(parsed, allow, signal) {
    if (!parsed.semanticText || !vectorStore || !embedQuery || !(await isSemanticReady())) return null;
    // Cached query vectors belong to the model that made them: drop them when the index is rebuilt for another one.
    const stored = typeof vectorStore.getConfig === 'function' ? await vectorStore.getConfig() : null;
    const stamp = stored ? [stored.providerId, stored.model, stored.requestedDims || '', stored.createdAt].join('\u0000') : '';
    if (stamp !== vectorStamp) { queryVectors.clear(); vectorStamp = stamp; }
    const chunks = await vectorStore.allChunks();
    if (!chunks.length) return null;
    const vector = await vectorFor(parsed.semanticText, signal);
    return semanticRank(vector, chunks, { allow });
  }

  async function searchLibrary(query, { limit = 20, mode = 'hybrid', filter = {}, operators = true, chunks: wantChunks = 0, signal } = {}) {
    const library = await getLibrary();
    const items = Array.isArray(library?.items) ? library.items : [];
    if (library?.updatedAt && library.updatedAt !== pruneStamp) { pruneStamp = library.updatedAt; cache.prune(new Set(items.map(item => item.id))); }
    const size = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.floor(limit) : 20));
    const parsed = parseQuery(query, { operators });
    const matchesFilter = itemMatcher(library, filter || {});
    const matchesQuery = queryMatcher(parsed, cache);
    const index = new Map(items.map(item => [item.id, item]));
    const allowItem = item => matchesFilter(item) && matchesQuery(item);
    let semantic = null;
    if (mode !== 'lexical') {
      try { semantic = await semanticCandidates(parsed, id => allowItem(index.get(id)), signal); }
      catch (error) { if (signal?.aborted) throw error; semantic = null; }
    }
    const round = value => Math.round(value * 1e6) / 1e6;
    const chunkTexts = hit => (hit && wantChunks > 0 ? [hit.chunk, hit.next?.chunk].slice(0, Math.min(2, wantChunks)).map(chunk => text(chunk?.text)).filter(Boolean) : []);
    const describe = (entry, source, score, snippet, { lexicalHit = null, semanticHit = null } = {}) => {
      const item = index.get(entry.id);
      const passages = chunkTexts(semanticHit);
      return { id: entry.id, score: round(score), snippet, source, title: text(item?.title), type: text(item?.type), url: text(item?.url),
        ...(lexicalHit ? { lexicalScore: round(lexicalHit.score) } : {}), ...(semanticHit ? { semanticScore: round(semanticHit.score) } : {}), ...(passages.length ? { chunks: passages } : {}) };
    };
    const chunkSnippet = hit => makeSnippet(plainText(hit.chunk.text), parsed.words);
    if (mode === 'semantic' && semantic) {
      return semanticHead(semantic, { size }).map(hit => describe(hit, 'semantic', hit.score, chunkSnippet(hit), { semanticHit: hit }));
    }
    const lexical = lexicalSearch(items, parsed, { allow: matchesFilter, cache, limit: semantic ? Math.max(size * 3, 60) : size });
    if (!semantic || !semantic.length) return lexical.slice(0, size).map(hit => describe(hit, 'lexical', hit.score, hit.snippet, { lexicalHit: hit }));
    const head = semanticHead(semantic, { size: Math.max(size * 2, 30) });
    const lexicalById = new Map(lexical.map(hit => [hit.id, hit]));
    const semanticById = new Map(head.map(hit => [hit.id, hit]));
    return reciprocalRankFusion([lexical, head]).slice(0, size).map(row => {
      const lexicalHit = lexicalById.get(row.id);
      const semanticHit = semanticById.get(row.id);
      const source = lexicalHit && semanticHit ? 'both' : lexicalHit ? 'lexical' : 'semantic';
      return describe(row, source, row.score, lexicalHit?.snippet || chunkSnippet(semanticHit), { lexicalHit, semanticHit });
    });
  }

  async function centroids(chunks) {
    if (centroidCache.has(chunks)) return centroidCache.get(chunks);
    const grouped = new Map();
    for (const chunk of chunks) grouped.set(chunk.itemId, [...(grouped.get(chunk.itemId) || []), chunk]);
    const result = new Map();
    for (const [id, list] of grouped) result.set(id, { vector: centroid(list.map(chunk => chunk.vector)), chunks: list });
    centroidCache.set(chunks, result);
    return result;
  }

  /** Semantic neighbours of an item by centroid similarity; [] when the index is off or the item is not indexed yet. */
  async function relatedItems(itemId, { limit = 8 } = {}) {
    if (typeof itemId !== 'string' || !vectorStore || !(await isSemanticReady())) return [];
    const [library, chunks] = await Promise.all([getLibrary(), vectorStore.allChunks()]);
    const items = new Map((library?.items || []).map(item => [item.id, item]));
    const allow = itemMatcher(library, { archived: 'all', excludeIds: [itemId] });
    const groups = await centroids(chunks);
    const origin = groups.get(itemId)?.vector;
    if (!origin) return [];
    const ranked = [...groups].filter(([id, group]) => group.vector && allow(items.get(id)))
      .map(([id, group]) => ({ id, score: dot(origin, group.vector), group }))
      .filter(entry => !Number.isNaN(entry.score))
      .sort((a, b) => b.score - a.score || byId(a, b));
    const size = Math.max(1, Math.min(50, Number.isFinite(limit) ? Math.floor(limit) : 8));
    return semanticHead(ranked, { size, relative: 0.7, floor: 0.2 }).map(({ id, score, group }) => {
      const best = group.chunks.reduce((top, chunk) => dot(origin, chunk.vector) > dot(origin, top.vector) ? chunk : top, group.chunks[0]);
      const item = items.get(id);
      return { id, score: Math.round(score * 1e6) / 1e6, title: text(item?.title), type: text(item?.type), url: text(item?.url), snippet: makeSnippet(plainText(best.text), []) };
    });
  }

  /** Tokenizes the library in idle slices so the first search after startup does not block on a large library. */
  async function warm({ slice = 40 } = {}) {
    const library = await getLibrary();
    const items = Array.isArray(library?.items) ? library.items : [];
    const idle = () => new Promise(resolve => globalThis.requestIdleCallback ? globalThis.requestIdleCallback(() => resolve(), { timeout: 1000 }) : setTimeout(resolve, 0));
    for (let index = 0; index < items.length; index++) {
      if (items[index] && typeof items[index].id === 'string' && !items[index].deletedAt) cache.get(items[index]);
      if (index % slice === slice - 1) await idle();
    }
  }

  return { searchLibrary, relatedItems, warm };
}

// Knowledge map: explicit links between items (lib/library-views.js buildRelationshipGraph, 920×580 space) laid out
// with a deterministic force pass, scoped to all items, the Inbox or a collection, filtered by text and type, and
// optionally joined by dashed "similar" edges from the semantic index. A subpage is linked to the page it sits in.
import { html, cx, plural } from './html.js';
import { icon, hasIcon } from './icons.js';
import { button, iconButton, segmented, searchField, switchToggle, emptyState, collectionIcon, colorVar, TYPE_LABELS } from './components.js';
import { registerActions, registerMount } from './runtime.js';
import { searchRows } from './selectors.js';
import { buildRelationshipGraph } from '../lib/library-views.js';
import { createNote } from './notes.js';
import { parentIdOf } from '../lib/pages.js';

export const MAP_WIDTH = 920;
export const MAP_HEIGHT = 580;
const LIMIT = 60;
// "All" leaves out AI chats (synced from Threadkeeper, often thousands); the Chats filter shows them.
const TYPE_FILTERS = [
  { value: 'all', label: 'All' }, { value: 'note', label: 'Notes' }, { value: 'link', label: 'Links' }, { value: 'media', label: 'Media' }, { value: 'chat', label: 'Chats' },
];
const KIND = { note: 'note', bookmark: 'link', article: 'link', image: 'media', video: 'media', file: 'file', chat: 'chat' };

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

const typeMatches = (item, type) => type === 'all' || !type ? item.type !== 'chat'
  : type === 'link' ? ['bookmark', 'article'].includes(item.type)
  : type === 'media' ? ['image', 'video', 'file'].includes(item.type)
  : item.type === type;

/**
 * Adds page edges: a parent links to each of its subpages in the set (as if its relatedIds named them). Only parents
 * that gain a link are copied; the library's records are never changed.
 */
export function withPageLinks(items) {
  const ids = new Set(items.map(item => item.id));
  const extra = new Map();
  for (const item of items) {
    const parentId = parentIdOf(item);
    if (!parentId || !ids.has(parentId)) continue;
    if (!extra.has(parentId)) extra.set(parentId, []);
    extra.get(parentId).push(item.id);
  }
  if (!extra.size) return items;
  return items.map(item => {
    const children = extra.get(item.id);
    if (!children) return item;
    const related = item.relatedIds || [];
    const added = children.filter(id => !related.includes(id));
    return added.length ? { ...item, relatedIds: [...related, ...added] } : item;
  });
}

/**
 * Items for the map: type filter first, then the text query keeps matching items plus their direct neighbours
 * (so a match still shows what it links to). Returns { items, matches } where matches is the Set of matching ids.
 */
export function filterMapItems(items, { query = '', type = 'all', search = searchRows } = {}) {
  const typed = items.filter(item => typeMatches(item, type));
  if (!query.trim()) return { items: typed, matches: new Set() };
  const matches = new Set(search(typed, query).map(item => item.id));
  const keep = new Set(matches);
  for (const item of typed) {
    for (const target of item.relatedIds || []) {
      if (matches.has(item.id)) keep.add(target);
      if (matches.has(target)) keep.add(item.id);
    }
  }
  return { items: typed.filter(item => keep.has(item.id)), matches };
}

/** Similar-item edges between rendered nodes, skipping pairs that are already linked; one edge per pair. */
export function similarEdges(results, graph) {
  const nodes = new Set(graph.nodes.map(node => node.id));
  const pair = (a, b) => a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  const seen = new Set(graph.edges.map(edge => pair(edge.source, edge.target)));
  const out = [];
  for (const [source, related] of results) {
    for (const entry of related || []) {
      const target = entry?.id;
      if (!nodes.has(source) || !nodes.has(target) || source === target || seen.has(pair(source, target))) continue;
      seen.add(pair(source, target));
      out.push({ source, target, score: Number(entry.score) || 0 });
    }
  }
  return out;
}

/**
 * Deterministic force-directed layout seeded from the graph's grid positions. It runs in a square space (explicit
 * edges at full strength, similar edges at a third, gravity sized so the cloud settles at about the frame size) and
 * is then fitted into the 920×580 contract with padding, so the result keeps the graph's coordinate space.
 */
export function relaxLayout(graph, extraEdges = [], { width = MAP_WIDTH, height = MAP_HEIGHT, iterations = 300, padX = 70, padY = 50 } = {}) {
  const nodes = graph.nodes.map(node => ({ ...node }));
  const count = nodes.length;
  if (!count) return { ...graph, nodes };
  if (count === 1) return { ...graph, nodes: [{ ...nodes[0], x: width / 2, y: height / 2 }] };
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const links = [
    ...graph.edges.map(edge => [index.get(edge.source), index.get(edge.target), 1]),
    ...extraEdges.map(edge => [index.get(edge.source), index.get(edge.target), 0.35]),
  ].filter(([a, b]) => a !== undefined && b !== undefined && a !== b);
  const side = 480;
  const x = Float64Array.from(nodes, node => (node.x - width / 2) / width * side);
  const y = Float64Array.from(nodes, node => (node.y - height / 2) / height * side);
  const k = 0.6 * Math.sqrt((side * side) / count);
  const radius = 0.45 * side;
  const gravity = (count * k * k) / (radius * radius * radius);
  let heat = side / 10;
  for (let step = 0; step < iterations; step++) {
    const fx = new Float64Array(count), fy = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let dx = x[i] - x[j], dy = y[i] - y[j];
        let d = Math.hypot(dx, dy);
        if (d < 0.01) { dx = ((i * 7 + j * 3) % 5) - 2 || 1; dy = ((i * 3 + j * 7) % 5) - 2 || 1; d = Math.hypot(dx, dy); }
        const force = (k * k) / d;
        fx[i] += dx / d * force; fy[i] += dy / d * force;
        fx[j] -= dx / d * force; fy[j] -= dy / d * force;
      }
    }
    for (const [a, b, weight] of links) {
      const dx = x[a] - x[b], dy = y[a] - y[b];
      const d = Math.hypot(dx, dy) || 0.01;
      const force = (d * d) / k * weight;
      fx[a] -= dx / d * force; fy[a] -= dy / d * force;
      fx[b] += dx / d * force; fy[b] += dy / d * force;
    }
    for (let i = 0; i < count; i++) {
      const d = Math.hypot(x[i], y[i]);
      fx[i] -= x[i] * gravity * d;
      fy[i] -= y[i] * gravity * d;
      const length = Math.hypot(fx[i], fy[i]) || 1;
      const move = Math.min(length, heat);
      x[i] += fx[i] / length * move;
      y[i] += fy[i] / length * move;
    }
    heat = Math.max(heat * 0.96, 0.25);
  }
  // Fit into the frame: each axis fills its padded span (centred when a span is flat).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) { minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]); minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]); }
  const fit = (value, min, max, size, pad) => max - min < 1 ? size / 2 : pad + (value - min) / (max - min) * (size - pad * 2);
  return { ...graph, nodes: nodes.map((node, i) => ({ ...node, x: Math.round(fit(x[i], minX, maxX, width, padX)), y: Math.round(fit(y[i], minY, maxY, height, padY)) })) };
}

/** Labels that would overlap a label already placed (higher-degree nodes first) are hidden until hover. */
export function crowdedLabels(nodes, { charWidth = 6.4, lineHeight = 16, radius = nodeRadius, max = 28 } = {}) {
  const placed = [];
  const hidden = new Set();
  for (const node of [...nodes].sort((a, b) => b.degree - a.degree || a.y - b.y || a.x - b.x)) {
    const w = Math.min(String(node.title || '').length, max) * charWidth;
    const box = { x1: node.x - w / 2, x2: node.x + w / 2, y1: node.y + radius(node.degree) + 4, y2: node.y + radius(node.degree) + 4 + lineHeight };
    const clash = placed.some(other => box.x1 < other.x2 && box.x2 > other.x1 && box.y1 < other.y2 && box.y2 > other.y1)
      || nodes.some(other => other !== node && Math.abs(other.x - node.x) < w / 2 + radius(other.degree) && other.y > box.y1 - radius(other.degree) && other.y < box.y2 + radius(other.degree));
    if (clash) hidden.add(node.id); else placed.push(box);
  }
  return hidden;
}

/** Labels near the frame edge align to the node's side instead of overflowing the frame. */
export function labelAnchor(node, width, { charWidth = 6.4, max = 28, margin = 4 } = {}) {
  const half = Math.min(String(node.title || '').length, max) * charWidth / 2;
  const r = nodeRadius(node.degree);
  if (node.x - half < margin) return { anchor: 'start', x: Math.round(-Math.min(r, node.x - margin)) };
  if (node.x + half > width - margin) return { anchor: 'end', x: Math.round(Math.min(r, width - margin - node.x)) };
  return { anchor: 'middle', x: 0 };
}

/** Node radius grows with its number of links. */
export const nodeRadius = degree => 7 + Math.min(Number(degree) || 0, 8) * 1.25;
const clip = (text, max) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

// ---------------------------------------------------------------------------------------------------------------
// State, data and caching

/** The legacy ?mapSpace= link parameter ('inbox' or 'space:<collectionId>') seeds the first scope. */
const bootScope = () => { try { return String(new URLSearchParams(globalThis.location?.search || '').get('mapSpace') || '').replace(/^space:/, ''); } catch { return ''; } };
const mapState = ctx => ctx.state.mapView ||= { scope: bootScope(), query: '', type: 'all', similar: false, similarFor: '', similarEdges: [], similarStatus: 'idle' };
/** Scope for the next map render: '' (all items), 'inbox' or a collection id. */
export function setMapScope(ctx, scope = '') { mapState(ctx).scope = scope; }

const safe = fn => { try { return fn(); } catch { return undefined; } };
const indexEnabled = ctx => !!safe(() => ctx.ai?.getIndexStatus?.())?.enabled;

function scopedItems(ctx, scope) {
  const live = ctx.select.live();
  if (scope === 'inbox') return live.filter(item => !item.collectionId);
  if (scope && ctx.select.collection(scope)) {
    const ids = new Set(ctx.select.descendants(scope));
    return live.filter(item => ids.has(item.collectionId));
  }
  return live;
}

const graphCache = new Map();
function graphFor(ctx) {
  const m = mapState(ctx);
  const scope = m.scope && m.scope !== 'inbox' && !ctx.select.collection(m.scope) ? '' : m.scope;
  const key = [ctx.library?.updatedAt, scope, m.query, m.type].join('|');
  if (!graphCache.has(key)) {
    const scoped = withPageLinks(scopedItems(ctx, scope));
    const { items, matches } = filterMapItems(scoped, { query: m.query, type: m.type });
    graphCache.set(key, { key, scope, scopedCount: scoped.length, matches, graph: buildRelationshipGraph(items, { limit: LIMIT }) });
    if (graphCache.size > 6) graphCache.delete(graphCache.keys().next().value);
  }
  return graphCache.get(key);
}

const layoutCache = new Map();
/** Full tab: the graph's 920×580 frame. Side panel: a portrait frame so labels stay legible in a narrow column. */
const FRAMES = { full: { width: MAP_WIDTH, height: MAP_HEIGHT, padX: 70, padY: 50 }, side: { width: 400, height: 600, padX: 44, padY: 30 } };
function layoutOf(entry, extra, similarKey, surface) {
  const key = `${entry.key}|${similarKey}|${surface}`;
  if (!layoutCache.has(key)) {
    const frame = FRAMES[surface] || FRAMES.full;
    layoutCache.set(key, { ...relaxLayout(entry.graph, extra, frame), similar: extra, matches: entry.matches, frame });
    if (layoutCache.size > 6) layoutCache.delete(layoutCache.keys().next().value);
  }
  return { key, layout: layoutCache.get(key) };
}

async function loadSimilar(ctx, entry) {
  const m = mapState(ctx);
  m.similarFor = entry.key;
  m.similarStatus = 'loading';
  m.similarEdges = [];
  try {
    // One call first: it loads and caches the vectors, so the rest reuse them instead of each reading the whole index.
    const ask = async node => [node.id, await Promise.resolve().then(() => ctx.ai.relatedItems(node.id, { limit: 4 })).catch(() => [])];
    const nodes = entry.graph.nodes;
    const results = nodes.length ? [await ask(nodes[0])] : [];
    for (let i = 1; i < nodes.length && m.similarFor === entry.key; i += 6) results.push(...await Promise.all(nodes.slice(i, i + 6).map(ask)));
    if (m.similarFor !== entry.key) return;
    m.similarEdges = similarEdges(results, entry.graph);
    m.similarStatus = 'done';
  } catch {
    if (m.similarFor === entry.key) m.similarStatus = 'error';
  }
  ctx.render();
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

function scopeButton(ctx, scope) {
  const collection = scope && scope !== 'inbox' ? ctx.select.collection(scope) : null;
  const name = collection ? ctx.select.path(collection.id).map(c => c.name).join(' / ') : scope === 'inbox' ? 'Inbox' : 'All items';
  const glyph = collection ? collectionIcon(collection, { size: 16 }) : icon(scope === 'inbox' ? 'inbox' : 'book-open-text', { size: 14 });
  const open = ctx.state.popover?.anchorEl?.dataset?.action === 'map.scope-menu';
  return html`<button type="button" class="btn btn-secondary btn-sm map-scope" data-action="map.scope-menu" aria-haspopup="menu" aria-expanded="${open ? 'true' : 'false'}" aria-label="Scope: ${name}">
    ${glyph}<span class="btn-label">${name}</span>${icon('chevron-down', { size: 14, className: 'btn-icon-right' })}</button>`;
}

function legend(similarOn, chats = false) {
  const key = (cls, text) => html`<span class="map-key"><span class="${cls}" aria-hidden="true"></span>${text}</span>`;
  return html`<div class="map-legend" role="note" aria-label="Legend">
    ${key('map-key-dot is-note', 'Notes')}${key('map-key-dot is-link', 'Links and articles')}${key('map-key-dot is-media', 'Images and video')}${key('map-key-dot is-file', 'Files')}${chats ? key('map-key-dot is-chat', 'AI chats') : ''}
    ${key('map-key-ring', 'Ring shows the collection')}
    <span class="map-legend-sep" aria-hidden="true"></span>
    ${key('map-key-line', 'Linked')}${key('map-key-line is-both', 'Linked both ways')}${similarOn ? key('map-key-line is-similar', 'Similar') : ''}
  </div>`;
}

function renderEmptyMap(ctx, entry, canSimilar, m) {
  if (!entry.scopedCount) {
    return emptyState({ icon: 'waypoints', title: 'Nothing to map here', body: 'This scope has no items yet. Choose another collection or All items.',
      actions: m.scope ? button({ label: 'Show all items', variant: 'secondary', size: 'sm', action: 'map.scope', data: { scope: '' } }) : '' });
  }
  if (!entry.graph.nodes.length) {
    return emptyState({ icon: 'filter-x', title: 'No items match', body: 'Try another word or type.', actions: button({ label: 'Clear filters', variant: 'secondary', size: 'sm', action: 'map.clear-filters' }) });
  }
  return emptyState({ icon: 'waypoints', title: 'No links yet',
    body: 'The map draws links between items. Link notes with [[Title]], or add related items from an item’s details.',
    actions: html`${button({ label: 'New note', icon: 'sticky-note', variant: 'secondary', size: 'sm', action: 'map.new-note' })}${canSimilar && !m.similar ? button({ label: 'Show similar items', icon: 'sparkles', variant: 'ghost', size: 'sm', action: 'map.similar-on' }) : ''}` });
}

/** The knowledge map view (full tab main area; also usable inside the side panel's library screen). */
export function renderMap(ctx, { surface = 'full' } = {}) {
  const m = mapState(ctx);
  const side = surface === 'side';
  const entry = graphFor(ctx);
  const canSimilar = indexEnabled(ctx) && typeof ctx.ai?.relatedItems === 'function';
  const similarOn = m.similar && canSimilar;
  if (similarOn && m.similarFor !== entry.key && entry.graph.nodes.length) loadSimilar(ctx, entry);
  const extra = similarOn && m.similarFor === entry.key ? m.similarEdges : [];
  const { key, layout } = layoutOf(entry, extra, similarOn ? `${m.similarStatus}:${extra.length}` : 'off', side ? 'side' : 'full');
  const { graph } = entry;
  const linked = graph.edges.length + extra.length > 0;
  const title = html`<span class="lib-head-glyph" aria-hidden="true">${icon('waypoints', { size: 16 })}</span>`;
  const counts = `${plural(graph.nodes.length, 'item')} · ${plural(graph.edges.length, 'link')}`;
  const tools = html`
    ${scopeButton(ctx, entry.scope)}
    ${searchField({ value: m.query, placeholder: 'Filter the map', action: 'map.search', id: 'map-search', clearAction: 'map.clear-search', label: 'Filter the map', className: 'map-search' })}
    <span class="lib-layout" data-keydown="library.seg-key">${segmented({ name: 'map-type', value: m.type, options: TYPE_FILTERS, action: 'map.type', size: 'sm', ariaLabel: 'Item types' })}</span>
    ${canSimilar ? switchToggle({ checked: m.similar, label: 'Include similar items', action: 'map.similar', className: 'map-similar' }) : ''}`;
  return html`<section class="${cx('map-view', side && 'is-side')}" data-surface="${surface}" data-key="map-view" aria-labelledby="map-title">
    <div class="lib-top">
      ${side ? html`<header class="lib-side-head">
          ${iconButton({ icon: 'arrow-left', label: 'Back', action: 'library.side-back', size: 'sm' })}
          <h1 class="lib-side-title" id="map-title" tabindex="-1">${title}<span class="lib-side-name">Knowledge map</span></h1>
        </header>`
        : html`<header class="lib-head">
          <div class="lib-heading">${title}<h1 class="lib-title" id="map-title" tabindex="-1">Knowledge map</h1><span class="lib-count">${counts}</span></div>
        </header>`}
      <div class="map-toolbar" role="group" aria-label="Map options">${tools}</div>
    </div>
    <div class="map-body">
      ${linked ? html`
        ${graph.truncated ? html`<p class="map-notice">${icon('info', { size: 14 })}<span>Showing ${graph.nodes.length} of ${graph.totalItems.toLocaleString()} items. Linked items come first; pick a collection or filter to focus.</span></p>` : ''}
        ${similarOn && m.similarStatus === 'loading' ? html`<p class="map-notice">${icon('loader-circle', { size: 14, className: 'map-spin' })}<span>Finding similar items…</span></p>` : ''}
        <div class="map-canvas" data-mount="map.canvas" data-morph="skip" data-key="map:${key}" data-layout-key="${key}"></div>
        ${legend(similarOn, m.type === 'chat')}`
        : html`<div class="lib-empty">${renderEmptyMap(ctx, entry, canSimilar, m)}</div>`}
    </div>
  </section>`;
}

function nodeKind(node) { return KIND[node.type] || 'link'; }

function svgMarkup(ctx, layout) {
  const pos = new Map(layout.nodes.map(node => [node.id, node]));
  const edgeLine = (edge, cls) => {
    const a = pos.get(edge.source), b = pos.get(edge.target);
    if (!a || !b) return '';
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    const ra = nodeRadius(a.degree) + 4, rb = nodeRadius(b.degree) + 5;
    const arrow = cls === 'is-one-way';
    return html`<line class="${cx('map-edge', cls)}" data-a="${edge.source}" data-b="${edge.target}" x1="${(a.x + dx / d * ra).toFixed(1)}" y1="${(a.y + dy / d * ra).toFixed(1)}"
      x2="${(b.x - dx / d * (rb + (arrow ? 2 : 0))).toFixed(1)}" y2="${(b.y - dy / d * (rb + (arrow ? 2 : 0))).toFixed(1)}" ${arrow ? html`marker-end="url(#map-arrow)"` : ''}></line>`;
  };
  const frame = layout.frame || FRAMES.full;
  const ordered = [...layout.nodes].sort((a, b) => a.y - b.y || a.x - b.x);
  const crowded = crowdedLabels(layout.nodes);
  const node = n => {
    const r = nodeRadius(n.degree);
    const collection = n.collectionId ? ctx.select.collection(n.collectionId) : null;
    const name = collection?.name;
    const kind = nodeKind(n);
    const label = labelAnchor(n, frame.width);
    return html`<g class="${cx('map-node', `is-${kind}`, !n.degree && 'is-orphan', crowded.has(n.id) && 'is-crowded', layout.matches?.has(n.id) && 'is-match')}" data-id="${n.id}" data-action="app.open-item"
        transform="translate(${n.x} ${n.y})" tabindex="0" role="button" aria-label="${n.title}, ${TYPE_LABELS[n.type] || 'Item'}${name ? `, in ${name}` : ''}, ${plural(n.degree, 'link')}"
        ${collection ? html`style="--ring:${colorVar(collection.color)}"` : ''}>
      <circle class="map-node-hit" r="${r + 8}"></circle>
      <circle class="${cx('map-node-ring', collection && 'has-collection')}" r="${r + 3}"></circle>
      <circle class="map-node-dot" r="${r}"></circle>
      <text class="map-node-label" x="${label.x}" y="${r + 15}" text-anchor="${label.anchor}">${clip(n.title, 28)}</text>
    </g>`;
  };
  return html`<svg class="map-svg" viewBox="0 0 ${frame.width} ${frame.height}" preserveAspectRatio="xMidYMid meet" role="group" aria-label="Knowledge map with ${plural(layout.nodes.length, 'item')} and ${plural(layout.edges.length, 'link')}">
    <defs><marker id="map-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="map-arrow" d="M0 1 L9 5 L0 9 z"></path></marker></defs>
    <g class="map-edges">${layout.edges.map(edge => edgeLine(edge, edge.bidirectional ? 'is-both' : 'is-one-way'))}${(layout.similar || []).map(edge => edgeLine(edge, 'is-similar'))}</g>
    <g class="map-nodes">${ordered.map(node)}</g>
  </svg><p class="map-status sr-only" aria-live="polite"></p>`;
}

registerMount('map.canvas', (el, ctx) => {
  const layout = layoutCache.get(el.dataset.layoutKey);
  if (!layout) return null;
  el.innerHTML = String(svgMarkup(ctx, layout));
  const svg = el.querySelector('svg');
  const status = el.querySelector('.map-status');
  const neighbours = new Map();
  for (const edge of [...layout.edges, ...(layout.similar || [])]) {
    if (!neighbours.has(edge.source)) neighbours.set(edge.source, new Set());
    if (!neighbours.has(edge.target)) neighbours.set(edge.target, new Set());
    neighbours.get(edge.source).add(edge.target);
    neighbours.get(edge.target).add(edge.source);
  }
  const nodeEls = [...svg.querySelectorAll('.map-node')];
  const edgeEls = [...svg.querySelectorAll('.map-edge')];
  let current = null;
  const spotlight = id => {
    if (id === current) return;
    current = id;
    svg.classList.toggle('has-focus', !!id);
    const near = id ? neighbours.get(id) || new Set() : new Set();
    for (const n of nodeEls) n.classList.toggle('is-hot', !!id && (n.dataset.id === id || near.has(n.dataset.id)));
    for (const e of edgeEls) e.classList.toggle('is-hot', !!id && (e.dataset.a === id || e.dataset.b === id));
    if (id && status) {
      const n = layout.nodes.find(node => node.id === id);
      status.textContent = n ? `${n.title}: ${plural(near.size, 'connection')}` : '';
    }
  };
  const onOver = event => { const n = event.target.closest?.('.map-node'); if (n) spotlight(n.dataset.id); };
  const onLeave = () => { if (!svg.contains(document.activeElement)) spotlight(null); };
  const onFocus = event => { const n = event.target.closest?.('.map-node'); if (n) spotlight(n.dataset.id); };
  const onBlur = event => { if (!svg.contains(event.relatedTarget)) spotlight(null); };
  const onKey = event => {
    const n = event.target.closest?.('.map-node');
    if (!n) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); ctx.openItem(n.dataset.id); return; }
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[event.key];
    if (!dir) return;
    event.preventDefault();
    const from = layout.nodes.find(node => node.id === n.dataset.id);
    let best = null, score = Infinity;
    for (const other of layout.nodes) {
      if (other.id === from.id) continue;
      const dx = other.x - from.x, dy = other.y - from.y;
      const along = dx * dir[0] + dy * dir[1];
      if (along <= 0) continue;
      const across = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]);
      const s = along + across * 2;
      if (s < score) { score = s; best = other; }
    }
    if (best) nodeEls.find(el2 => el2.dataset.id === best.id)?.focus();
  };
  svg.addEventListener('pointerover', onOver);
  svg.addEventListener('pointerleave', onLeave);
  svg.addEventListener('focusin', onFocus);
  svg.addEventListener('focusout', onBlur);
  svg.addEventListener('keydown', onKey);
  return { destroy() { svg.removeEventListener('pointerover', onOver); svg.removeEventListener('pointerleave', onLeave); svg.removeEventListener('focusin', onFocus); svg.removeEventListener('focusout', onBlur); svg.removeEventListener('keydown', onKey); } };
});

function pickScope(ctx, anchor) {
  const m = mapState(ctx);
  const choose = scope => { m.scope = scope; ctx.render(); };
  const recent = ctx.select.recentCollections(6);
  ctx.openMenu(anchor, [
    { label: 'All items', icon: 'book-open-text', checked: !m.scope, run: () => choose('') },
    { label: 'Inbox', icon: 'inbox', checked: m.scope === 'inbox', run: () => choose('inbox') },
    ...(recent.length ? [{ separator: true }, { heading: 'Recent collections' }] : []),
    // Menus take icon names only; an emoji collection icon would log and fall back to a blank circle.
    ...recent.map(c => ({ label: c.name, icon: hasIcon(c.icon) ? c.icon : 'folder', checked: m.scope === c.id, run: () => choose(c.id) })),
    { separator: true },
    { label: 'Choose collection…', icon: 'folder-tree', run: () => {
      try { ctx.openPopover('pick.collection', anchor, { value: m.scope && m.scope !== 'inbox' ? m.scope : undefined, onPick: id => choose(id || 'inbox'), allowInbox: true, title: 'Map a collection' }); }
      catch { ctx.openMenu(anchor, ctx.select.tree().map(c => ({ label: ctx.select.path(c.id).map(p => p.name).join(' / '), icon: 'folder', checked: m.scope === c.id, run: () => choose(c.id) })), { label: 'Collections' }); }
    } },
  ], { label: 'Map scope' });
}

let searchTimer = 0;
registerActions({
  'map.scope-menu': ({ ctx, el }) => pickScope(ctx, el),
  'map.scope': ({ ctx, data }) => { mapState(ctx).scope = data.scope || ''; ctx.render(); },
  'map.type': ({ ctx, data }) => { mapState(ctx).type = data.value; ctx.render(); },
  'map.search': ({ ctx, el }) => {
    clearTimeout(searchTimer);
    const value = el.value;
    searchTimer = setTimeout(() => { mapState(ctx).query = value; ctx.render(); }, 160);
  },
  'map.clear-search': ({ ctx }) => { mapState(ctx).query = ''; ctx.render(); ctx.nextFrame(() => document.getElementById('map-search')?.focus()); },
  'map.clear-filters': ({ ctx }) => { Object.assign(mapState(ctx), { query: '', type: 'all' }); ctx.render(); },
  'map.similar': ({ ctx, el }) => { mapState(ctx).similar = !!el.checked; ctx.render(); },
  'map.similar-on': ({ ctx }) => { mapState(ctx).similar = true; ctx.render(); },
  'map.new-note': ({ ctx }) => createNote(ctx, { title: '', content: '' }),
});

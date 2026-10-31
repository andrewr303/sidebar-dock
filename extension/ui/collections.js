// Collection editor dialog, delete flow and the pure tree helpers shared by the sidebar, the side panel and the palette.
import { html, cx, plural, safeSrc } from './html.js';
import { icon, iconChoices, COLLECTION_COLORS } from './icons.js';
import { button, dialogFrame, field, select, switchToggle, collectionIcon, colorName, colorVar } from './components.js';
import { registerDialog } from './overlay.js';
import { registerActions } from './runtime.js';

const DIALOG = 'collections.edit';
const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Rows of an ordered tree (selectors.tree()) that are visible with the given expanded ids, annotated for ARIA:
 * { ...row, expanded, parentKey, setSize, posInSet }. Children of a collapsed row are skipped.
 */
export function visibleTree(tree, expanded = new Set()) {
  const parentKey = row => (row.depth > 0 ? row.parentId || '' : '');
  const siblings = new Map();
  for (const row of tree) {
    const key = parentKey(row);
    if (!siblings.has(key)) siblings.set(key, []);
    siblings.get(key).push(row.id);
  }
  const out = [];
  let skipDeeperThan = Infinity;
  for (const row of tree) {
    if (row.depth > skipDeeperThan) continue;
    skipDeeperThan = Infinity;
    const open = !!row.hasChildren && expanded.has(row.id);
    const group = siblings.get(parentKey(row));
    out.push({ ...row, expanded: open, parentKey: parentKey(row), setSize: group.length, posInSet: group.indexOf(row.id) + 1 });
    if (row.hasChildren && !open) skipDeeperThan = row.depth;
  }
  return out;
}

/** Collections a collection may move into: everything except itself and its descendants. */
export function parentChoices(tree, id) {
  const out = [];
  let skipDeeperThan = Infinity;
  for (const row of tree) {
    if (row.depth > skipDeeperThan) continue;
    skipDeeperThan = Infinity;
    if (id && row.id === id) { skipDeeperThan = row.depth; continue; }
    out.push(row);
  }
  return out;
}

/** Ids of a collection and every collection nested inside it (cycle safe). */
export function descendantIds(collections, id) {
  const result = [id];
  const seen = new Set(result);
  for (let i = 0; i < result.length; i++) {
    for (const c of collections) if (c.parentId === result[i] && !seen.has(c.id)) { seen.add(c.id); result.push(c.id); }
  }
  return result;
}

/** A library holding one collection subtree (root moved to the top level) and its items, for bookmark HTML export. */
export function collectionSubset(library, id) {
  const ids = new Set(descendantIds(library.collections, id));
  return {
    ...library,
    settings: {},
    collections: library.collections.filter(c => ids.has(c.id)).map(c => (c.id === id ? { ...c, parentId: '' } : c)),
    items: library.items.filter(item => !item.deletedAt && ids.has(item.collectionId)),
  };
}

const colorHex = value => {
  const named = COLLECTION_COLORS.find(c => c.name === value);
  if (named) return named.hex;
  return /^#[\da-f]{3,8}$/i.test(String(value || '')) ? value : COLLECTION_COLORS.find(c => c.name === 'blue').hex;
};
const iconLabel = name => String(name).replace(/-/g, ' ');

export function openCollectionEditor(ctx, { id = '', parentId = '', onSaved } = {}) {
  const existing = id ? ctx.select.collection(id) : null;
  if (id && !existing) { ctx.toast('That collection no longer exists.', { tone: 'danger' }); return; }
  // New collections cycle through the palette so siblings are told apart at a glance.
  const fresh = COLLECTION_COLORS.filter(c => c.name !== 'gray');
  const draft = existing
    ? { name: existing.name, parentId: existing.parentId || '', icon: existing.icon || 'folder', color: colorHex(existing.color),
      description: existing.description || '', cover: existing.cover || '', pinned: !!existing.pinned }
    : { name: '', parentId: parentId && ctx.select.collection(parentId) ? parentId : '', icon: 'folder',
      color: fresh[(ctx.library?.collections?.length || 0) % fresh.length].hex, description: '', cover: '', pinned: false };
  ctx.openDialog(DIALOG, { id, updatedAt: existing?.updatedAt, draft, iconQuery: '', error: '', nameError: '', coverError: '', saving: false, onSaved });
  ctx.nextFrame(() => revealInGrid(document.querySelector('.icon-grid input:checked')?.closest('.icon-choice')));
}

/** Scrolls an icon grid (and only the grid, never the page) so `cell` sits in its middle; icons can be hundreds of cells deep. */
export function revealInGrid(cell) {
  const grid = cell?.parentElement;
  if (!grid) return;
  const offset = cell.getBoundingClientRect().top - grid.getBoundingClientRect().top;
  grid.scrollTop += offset - (grid.clientHeight - cell.offsetHeight) / 2;
}

function renderEditor(ctx, props) {
  const { id, draft, iconQuery, error, nameError, coverError, saving } = props;
  const tree = ctx.select.tree();
  // An emoji pick has no place in the groups, so it leads the grid while browsing; searching shows matches only.
  const emoji = EMOJI.test(draft.icon) && !iconQuery.trim() ? [['', [draft.icon]]] : [];
  const sections = [...emoji, ...iconChoices(iconQuery, EMOJI.test(draft.icon) ? '' : draft.icon)];
  const knownColor = COLLECTION_COLORS.some(c => c.hex.toLowerCase() === String(draft.color).toLowerCase());
  const colors = knownColor ? COLLECTION_COLORS : [...COLLECTION_COLORS, { name: '', hex: draft.color }];
  const parentOptions = [{ value: '', label: 'None (top level)' },
    ...parentChoices(tree, id).map(row => ({ value: row.id, label: `${'   '.repeat(row.depth)}${row.name}` }))];

  const body = html`
    ${error ? html`<p class="collection-editor-error" role="alert">${icon('circle-alert', { size: 16 })}<span>${error}</span></p>` : ''}
    <div class="collection-editor-identity">
      ${collectionIcon({ icon: draft.icon, color: draft.color }, { size: 32, className: 'collection-editor-preview' })}
      ${field({ label: 'Name', id: 'collection-name', error: nameError, className: 'collection-editor-name', control: html`<input class="input" id="collection-name"
        name="name" value="${draft.name}" maxlength="500" placeholder="Design references" autocomplete="off" spellcheck="false" data-autofocus
        ${nameError ? html`aria-invalid="true" aria-describedby="collection-name-error"` : ''}>` })}
    </div>
    ${field({ label: 'Parent collection', id: 'collection-parent', control: select({ name: 'parentId', id: 'collection-parent', value: draft.parentId, options: parentOptions }) })}
    <div class="collection-editor-look" role="group" aria-labelledby="collection-look-label">
      <span class="field-label" id="collection-look-label">Icon and color</span>
      <div class="color-grid" role="radiogroup" aria-label="Color">
        ${colors.map(c => html`<label class="color-choice" title="${c.name ? c.name[0].toUpperCase() + c.name.slice(1) : 'Custom color'}">
          <input type="radio" name="color" value="${c.hex}" aria-label="${c.name || 'Custom color'}" ${String(c.hex).toLowerCase() === String(draft.color).toLowerCase() ? 'checked' : ''}>
          <span class="color-choice-dot" style="--dot:${c.name ? `var(--c-${c.name})` : colorVar(c.hex)}"></span></label>`)}
      </div>
      <span class="input-wrap icon-search">${icon('search', { size: 14, className: 'input-icon' })}<input class="input input-sm has-icon" name="iconQuery"
        value="${iconQuery}" placeholder="Search icons" aria-label="Search icons" autocomplete="off" spellcheck="false" data-icon-search></span>
      <div class="icon-grid" role="radiogroup" aria-label="Icon" data-color="${colorName(draft.color) || ''}" style="--tile:${colorVar(draft.color)}">
        ${sections.length ? sections.map(([label, names]) => html`${label ? html`<div class="icon-grid-heading">${label}</div>` : ''}${names.map(name => html`<label class="icon-choice" title="${iconLabel(name)}">
          <input type="radio" name="icon" value="${name}" aria-label="${iconLabel(name)}" ${name === draft.icon ? 'checked' : ''}>
          <span class="icon-choice-box">${EMOJI.test(name) ? html`<span class="collection-emoji">${name}</span>` : icon(name, { size: 16 })}</span></label>`)}`)
          : html`<p class="icon-grid-empty">No icons match “${iconQuery}”</p>`}
      </div>
    </div>
    ${field({ label: 'Description', id: 'collection-description', control: html`<textarea class="textarea" id="collection-description" name="description" rows="2"
      maxlength="12000" placeholder="What belongs here">${draft.description}</textarea>` })}
    ${field({ label: 'Cover image', id: 'collection-cover', error: coverError, hint: 'Optional. An https address of an image.', control: html`<input class="input"
      id="collection-cover" name="cover" type="url" value="${draft.cover}" placeholder="https://" autocomplete="off" spellcheck="false"
      ${coverError ? html`aria-invalid="true" aria-describedby="collection-cover-error"` : html`aria-describedby="collection-cover-hint"`}>` })}
    ${switchToggle({ name: 'pinned', checked: draft.pinned, label: 'Pin to the top', description: 'Pinned collections are listed first among their siblings.' })}`;

  const footer = html`
    ${id ? button({ label: 'Delete', icon: 'trash-2', variant: 'ghost', action: 'collections.delete', data: { id }, className: 'collection-editor-delete' }) : ''}
    <span class="spacer"></span>
    ${button({ label: 'Cancel', variant: 'secondary', action: 'overlay.dismiss' })}
    ${button({ label: id ? 'Save' : 'Create collection', variant: 'primary', type: 'submit', loading: saving, attrs: { 'aria-keyshortcuts': ctx.env.isMac ? 'Meta+Enter' : 'Control+Enter' } })}`;

  return html`<form class="dialog-form collection-editor" data-submit="collections.save" data-input="collections.draft" data-keydown="collections.form-key" novalidate>
    ${dialogFrame({ name: DIALOG, title: id ? 'Edit collection' : 'New collection', body, footer })}</form>`;
}

registerDialog(DIALOG, renderEditor, { size: 'md', className: 'collection-editor-dialog' });

const editorEntry = ctx => ctx.state.dialogs.findLast(d => d.name === DIALOG);
function readDraft(form, previous) {
  const data = new FormData(form);
  const value = key => (data.has(key) ? String(data.get(key)) : previous[key]);
  return { name: value('name'), parentId: value('parentId'), icon: value('icon'), color: value('color'),
    description: value('description'), cover: value('cover'), pinned: data.get('pinned') === 'on' };
}

const friendly = message => /Conflict/i.test(message)
  ? 'This collection changed in another view. Close this dialog and open it again to edit the latest version.'
  : message || 'The collection could not be saved. Try again.';

/** Asks before deleting; items in the collection move to Inbox and nested collections move up one level (store semantics). */
export async function deleteCollectionFlow(ctx, id) {
  const collection = ctx.select.collection(id);
  if (!collection) return false;
  const items = ctx.select.counts().byCollection[id] || 0;
  const children = ctx.select.tree().filter(row => row.parentId === id).length;
  const body = [items ? `${plural(items, 'item')} in it will move to Inbox.` : 'It has no items.',
    children ? `${plural(children, 'collection')} inside it will move up one level.` : ''].filter(Boolean).join(' ');
  const ok = await ctx.confirm({ title: `Delete “${collection.name}”?`, body, confirmLabel: 'Delete collection', tone: 'danger' });
  if (!ok) return false;
  await ctx.store.deleteCollection(id, { expectedUpdatedAt: collection.updatedAt });
  ctx.prefs.toggleInList('expandedCollections', id, false);
  ctx.prefs.set('recentCollections', ctx.prefs.get('recentCollections', []).filter(x => x !== id));
  if (ctx.state.view === `collection:${id}`) {
    ctx.navigate(collection.parentId && ctx.select.collection(collection.parentId) ? `collection:${collection.parentId}` : 'all');
  }
  ctx.toast(`Deleted ${collection.name}`);
  return true;
}

registerActions({
  'collections.new': ({ ctx, data }) => openCollectionEditor(ctx, { parentId: data?.parent || '' }),
  'collections.edit': ({ ctx, data }) => openCollectionEditor(ctx, { id: data.id }),
  'collections.draft': ({ ctx, el, event }) => {
    const entry = editorEntry(ctx);
    if (!entry) return;
    const target = event?.target;
    if (target?.name === 'iconQuery') { entry.props.iconQuery = target.value; entry.props.draft = readDraft(el, entry.props.draft); ctx.render(); return; }
    entry.props.draft = readDraft(el, entry.props.draft);
    // Text fields keep their own value; only choices that change the preview need a render.
    if (target?.type === 'radio' || (target?.name === 'name' && entry.props.nameError)) {
      if (target.name === 'name') entry.props.nameError = '';
      ctx.render();
    }
  },
  'collections.form-key': ({ ctx, el, event }) => {
    if (event.key !== 'Enter') return;
    if ((ctx.env.isMac ? event.metaKey : event.ctrlKey)) { event.preventDefault(); el.requestSubmit(); return; }
    if (event.target.matches('[data-icon-search]')) {
      // Enter in the icon search picks the first match instead of submitting the form.
      event.preventDefault();
      const first = el.querySelector('.icon-grid input[type="radio"]');
      if (first) { first.checked = true; first.dispatchEvent(new Event('input', { bubbles: true })); first.focus(); }
    }
  },
  'collections.save': async ({ ctx, el }) => {
    const entry = editorEntry(ctx);
    if (!entry || entry.props.saving) return;
    const { id, updatedAt, onSaved } = entry.props;
    const draft = readDraft(el, entry.props.draft);
    const name = draft.name.trim();
    const cover = draft.cover.trim();
    const nameError = name ? '' : 'Enter a name for the collection.';
    const coverError = cover && !/^https?:/i.test(safeSrc(cover)) ? 'Enter an http or https image address, or leave it empty.' : '';
    Object.assign(entry.props, { draft, nameError, coverError, error: '' });
    if (nameError || coverError) {
      ctx.render();
      ctx.nextFrame(() => document.getElementById(nameError ? 'collection-name' : 'collection-cover')?.focus());
      return;
    }
    const patch = { name, parentId: draft.parentId, icon: draft.icon || 'folder', color: colorHex(draft.color),
      description: draft.description.trim(), cover, pinned: draft.pinned };
    entry.props.saving = true;
    ctx.render();
    let saved;
    try {
      saved = id ? await ctx.store.updateCollection(id, patch, { expectedUpdatedAt: updatedAt }) : await ctx.store.createCollection(patch);
    } catch (error) {
      Object.assign(entry.props, { saving: false, error: friendly(error?.message) });
      ctx.render();
      return;
    }
    ctx.closeDialog(DIALOG);
    if (patch.parentId) ctx.prefs.toggleInList('expandedCollections', patch.parentId, true);
    if (id) ctx.toast('Collection saved', { tone: 'success' });
    else {
      ctx.prefs.touchCollection(saved.id);
      ctx.toast(`Created ${saved.name}`, { tone: 'success' });
      if (!onSaved) ctx.navigate(`collection:${saved.id}`);
    }
    onSaved?.(saved);
  },
  'collections.delete': async ({ ctx, data }) => {
    // The confirm stacks over the editor, so Cancel returns to the editor with its unsaved changes intact.
    const deleted = await deleteCollectionFlow(ctx, data.id);
    if (deleted && editorEntry(ctx)) ctx.closeDialog(DIALOG);
  },
});

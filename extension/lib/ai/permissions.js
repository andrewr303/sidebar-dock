// Assistant permission levels (Settings > Assistant permissions). Pure: the tool session, the prompts and the settings UI
// share these rules. Every write the assistant stages belongs to one of five categories, and each category is 'ask' (the
// change waits on a proposal card) or 'allow' (it applies at once, with Undo on the receipt). A proposal applies by itself
// only when EVERY change in it is allowed and it changes at most MAX_AUTO_ITEMS items; anything this build cannot
// classify always asks, so a newer or unknown operation never runs unreviewed by mistake.

export const PERMISSION_LEVELS = Object.freeze(['ask', 'allow']);

export const PERMISSION_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'create', label: 'Create', hint: 'New notes, saved links, imported chats and collections' }),
  Object.freeze({ id: 'organize', label: 'Organize', hint: 'Move items, tags, favorites, archive, restore, links between items' }),
  Object.freeze({ id: 'edit', label: 'Edit', hint: 'Change titles, notes and collection details' }),
  Object.freeze({ id: 'dashboard', label: 'Dashboard', hint: 'Add widgets to your boards' }),
  Object.freeze({ id: 'delete', label: 'Delete', hint: 'Move to Trash, delete collections and tags' }),
]);
const CATEGORY_IDS = PERMISSION_CATEGORIES.map(category => category.id);

const levels = pick => Object.freeze(Object.fromEntries(CATEGORY_IDS.map(id => [id, pick(id)])));
export const PERMISSION_PRESETS = Object.freeze({
  ask: levels(() => 'ask'),
  trusted: levels(id => (id === 'delete' ? 'ask' : 'allow')),
  full: levels(() => 'allow'),
});
export const DEFAULT_PERMISSIONS = PERMISSION_PRESETS.ask;
// The most items one proposal may change without review. A bigger proposal asks even when every kind of change in it is
// allowed, so instructions hidden in page text or saved items cannot make one sweeping unreviewed change. The per-turn
// caps in lib/ai/tools.js still apply on top of this.
export const MAX_AUTO_ITEMS = 50;

// The write tools (lib/ai/tools.js LIBRARY_TOOLS). A tool can mean more than the op it stages: delete_tag stages
// remove_tags across every tagged item but is a deletion, so the tool is looked at before the op.
const TOOL_CATEGORIES = Object.freeze({
  create_note: 'create', save_links: 'create', create_collection: 'create', import_ai_threads: 'create',
  update_item: 'edit', append_to_note: 'edit', update_collection: 'edit', convert_items: 'edit', rename_tag: 'edit',
  move_items: 'organize', add_tags: 'organize', remove_tags: 'organize', set_favorite: 'organize', archive_items: 'organize',
  unarchive_items: 'organize', restore_items: 'organize', link_items: 'organize', unlink_items: 'organize',
  show_collection_on_dashboard: 'dashboard',
  trash_items: 'delete', delete_collection: 'delete', delete_tag: 'delete',
});
// The ops staged into a proposal (buildChanges / applyDraft). Most share their tool's name.
const OP_CATEGORIES = Object.freeze({
  create_note: 'create', save_links: 'create', create_collection: 'create', import_ai_threads: 'create',
  update_item: 'edit', append_to_note: 'edit', update_collection: 'edit', convert_items: 'edit', rename_tag: 'edit',
  move_items: 'organize', add_tags: 'organize', remove_tags: 'organize', set_favorite: 'organize', archive_items: 'organize',
  unarchive_items: 'organize', restore_items: 'organize', link_items: 'organize', unlink_items: 'organize',
  add_dashboard_widget: 'dashboard',
  trash_items: 'delete', delete_collection: 'delete',
});
// The ops a write tool can stage when they are not just the op of the same name (save_links also moves links that are
// already saved into the chosen collection; import_ai_threads moves and tags chats that are already in Still).
const TOOL_OPS = Object.freeze({ save_links: ['save_links', 'move_items'], delete_tag: ['remove_tags'], show_collection_on_dashboard: ['add_dashboard_widget'],
  import_ai_threads: ['import_ai_threads', 'move_items', 'add_tags'] });

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const lookup = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : null);

const given = value => value !== undefined && value !== null && value !== '';

/**
 * The category of one staged change, { tool, op, fields } -> 'create' | 'organize' | 'edit' | 'dashboard' | 'delete' | null.
 * The tool decides when there is one, else the op. update_item is an edit whatever its fields (a note field replaces the
 * whole body), so fields do not change the answer today. Unknown (including a tool this build does not know) -> null,
 * which always asks.
 */
export function categoryOf({ tool, op } = {}) {
  return given(tool) ? lookup(TOOL_CATEGORIES, tool) : lookup(OP_CATEGORIES, op);
}

/**
 * Every category one staged change touches: its tool's and its op's. A save_links that also moves an already saved link
 * into the folder needs Create and Organize; delete_tag needs Delete (and Organize, for the tags it removes).
 * Null when the tool or the op is unknown.
 */
export function categoriesOf({ tool, op } = {}) {
  const first = categoryOf({ tool, op });
  if (!first || !given(tool) || !given(op)) return first ? [first] : null;
  const second = lookup(OP_CATEGORIES, op);
  return second ? [...new Set([first, second])] : null;
}

/** { create, organize, edit, dashboard, delete }, each 'ask' or 'allow'. Anything that is not exactly 'allow' asks. */
export function normalizePermissions(value) {
  const source = isObject(value) ? value : {};
  return Object.fromEntries(CATEGORY_IDS.map(id => [id, source[id] === 'allow' ? 'allow' : 'ask']));
}

/** The preset the levels match ('ask' | 'trusted' | 'full'), else 'custom'. */
export function presetOf(permissions) {
  const current = normalizePermissions(permissions);
  for (const [name, preset] of Object.entries(PERMISSION_PRESETS)) if (CATEGORY_IDS.every(id => preset[id] === current[id])) return name;
  return 'custom';
}

/** The categories that apply without asking, in settings order. */
export function allowedCategories(permissions) {
  const current = normalizePermissions(permissions);
  return PERMISSION_CATEGORIES.filter(category => current[category.id] === 'allow');
}

// The tools a change names: a staged call has one ({ tool }); a proposal card row (buildChanges) lists every call
// grouped into it ({ tools }). A null or empty name stays in the list, so it fails the check below.
const toolsNamed = change => [...(Array.isArray(change.tools) ? change.tools : []), ...(change.tool !== undefined ? [change.tool] : [])];

const ids = value => (Array.isArray(value) ? value.filter(id => typeof id === 'string' && id) : []);
const counted = value => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/**
 * How many items a proposal changes. changes: the staged calls or the rows of a proposal card. Distinct ids from itemIds
 * and subpageIds (subpages the store moves or trashes along with a page), the relatedIds of an unlink_items (a link is
 * removed from both sides, so each related item changes too), plus one per created note (noteId, or the row's note.id)
 * and the items a deleted collection sends to Inbox (itemCount). Malformed entries count nothing here; autoApproves
 * refuses them anyway.
 */
export function changedItemCount(changes) {
  if (!Array.isArray(changes)) return 0;
  const seen = new Set();
  let extra = 0;
  for (const change of changes) {
    if (!isObject(change)) continue;
    for (const id of [...ids(change.itemIds), ...ids(change.subpageIds), ...(change.op === 'unlink_items' ? ids(change.relatedIds) : [])]) seen.add(id);
    if (change.op === 'create_note') {
      const id = typeof change.noteId === 'string' && change.noteId ? change.noteId : isObject(change.note) && typeof change.note.id === 'string' ? change.note.id : '';
      if (id) seen.add(id); else extra++;
    }
    extra += counted(change.itemCount);
  }
  return seen.size + extra;
}

/**
 * True when a proposal may apply without review: it has at least one change, every category of every change is
 * 'allow', and it changes at most MAX_AUTO_ITEMS items (changedItemCount). changes: the staged calls
 * [{ tool, op, fields?, itemIds?, noteId?, itemCount?, subpageIds?, relatedIds? }], or the rows of a proposal card
 * [{ tools: [...], op, itemIds, note?, itemCount?, relatedIds? }]. A change must name the tool(s) behind it and its op: the op alone
 * cannot tell delete_tag (a deletion) from remove_tags (organizing), so a change without a tool always asks.
 */
export function autoApproves(changes, permissions) {
  if (!Array.isArray(changes) || !changes.length) return false;
  if (changedItemCount(changes) > MAX_AUTO_ITEMS) return false;
  const current = normalizePermissions(permissions);
  return changes.every(change => {
    if (!isObject(change) || !given(change.op)) return false;
    const tools = toolsNamed(change);
    return tools.length > 0 && tools.every(tool => {
      const categories = given(tool) ? categoriesOf({ tool, op: change.op }) : null;
      return !!categories && categories.every(id => current[id] === 'allow');
    });
  });
}

/** True when everything a write tool can stage is allowed; used to describe the tool truthfully to the model. */
export function toolAutoApplies(tool, permissions) {
  if (!lookup(TOOL_CATEGORIES, tool)) return false;
  return autoApproves((TOOL_OPS[tool] || [tool]).map(op => ({ tool, op })), permissions);
}

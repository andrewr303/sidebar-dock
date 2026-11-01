// The dashboard as the assistant engine sees it (the `dashboard` option of lib/ai/tools.js createToolSession): a summary
// of the boards and their widgets, the one dashboard change it may propose (show a collection's links in a links-folder
// widget) and removing that widget again for Undo. ui/dashboard/index.js binds it to the real store (assistantDashboard); tests pass a store instance.
//
// Every call first awaits ready(), the dashboard view's preload(): it sets the first-run seed and loads and follows the
// stored dashboard. The side panel never loads the dashboard on its own, and a write before that would save an empty
// board over the person's dashboard, or overwrite edits another tab made since.

export const LINKS_WIDGET = 'links-folder';

const text = value => typeof value === 'string' ? value : '';

/**
 * createAssistantDashboard({ ready, store: { get, addWidget, findWidget, removeWidget }, getWidget, clampSize }) ->
 * { describe(), addCollectionWidget({ collectionId, boardId? }), removeWidget(widgetId) }
 */
export function createAssistantDashboard({ ready = async () => {}, store, getWidget, clampSize }) {
  async function loaded() {
    await ready();
    const state = store.get();
    if (!state) throw new Error('Your dashboard could not be opened. Open a new tab and try again.');
    return state;
  }

  function summary(widget) {
    const config = widget.config || {};
    const out = { id: widget.id, type: widget.type, title: text(widget.title) || text(getWidget(widget.type)?.title) };
    // Only a links folder shows a collection's saved links, so only it names one (a checklist or notes widget that reads
    // a collection does not put its links on the dashboard).
    if (widget.type === LINKS_WIDGET && text(config.collectionId)) {
      out.collectionId = config.collectionId;
      if (config.includeSubcollections === true) out.includeSubcollections = true;
    }
    return out;
  }

  return {
    /** { activeBoardId, boards: [{ id, name, widgets: [{ id, type, title, collectionId? }] }] } */
    async describe() {
      const state = await loaded();
      return { activeBoardId: state.activeBoardId, boards: state.boards.map(board => ({ id: board.id, name: board.name, widgets: board.widgets.map(summary) })) };
    },

    /** Adds a links-folder widget for the collection to a board (the active one by default) -> { widgetId, boardId }. */
    async addCollectionWidget({ collectionId, boardId } = {}) {
      const id = text(collectionId).trim();
      // A links folder cannot show the Inbox (links/model.js folderLinks drops '').
      if (!id || id.toLowerCase() === 'inbox') throw new Error('Choose a collection: the Inbox cannot be shown in a links widget.');
      const state = await loaded();
      if (boardId && !state.boards.some(board => board.id === boardId)) throw new Error('That dashboard board no longer exists.');
      const def = getWidget(LINKS_WIDGET);
      if (!def) throw new Error('The links widget is not available.');
      // Like the widget gallery: the definition's size and defaults, with the collection filled in so it needs no setup.
      const size = clampSize(def, def.size);
      let defaults = {};
      try { defaults = def.defaults?.() || {}; } catch (error) { console.error(error); }
      // No x/y: the store finds the first free spot (findFreeSpot) inside its write queue, against the board as it is
      // then, so a widget another tab added meanwhile is never overlapped.
      const widget = await store.addWidget(boardId || undefined, { type: LINKS_WIDGET, ...size, title: '', config: { ...defaults, collectionId: id },
        ...(def.style ? { style: { ...def.style } } : {}) });
      return { widgetId: widget.id, boardId: store.findWidget(widget.id)?.board.id || boardId || state.activeBoardId };
    },

    /** Removes a widget (Undo). A widget that is already gone is not an error: there is nothing left to undo. */
    async removeWidget(widgetId) {
      await loaded();
      if (!text(widgetId) || !store.findWidget(widgetId)) return;
      try { await store.removeWidget(widgetId); }
      catch (error) { if (store.findWidget(widgetId)) throw error; }
    },
  };
}

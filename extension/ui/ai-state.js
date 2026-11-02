// The assistant's shared view state (ctx.state.ai) and the full-screen assistant's address. ai-panel.js owns what the
// state means; this small module only creates it, so the research view (research-view.js) can read the same state
// without importing ai-panel.js (which imports the research view): no import cycle between them.

/** The shared assistant state (conversation, run, draft, history, context, model target), created on first use. */
export function aiState(ctx) {
  const s = ctx.state.ai ||= {};
  if (!s.init) {
    Object.assign(s, { init: true, conversation: null, draft: '', editing: null, run: null, explicit: null, added: [], dismissed: new Set(),
      target: undefined, connections: [], settings: null, history: null, historyQuery: '', ctxQuery: '', ctxActive: 0, ctxOptions: [],
      modelView: 'models', open: new Set(), pagePermission: null, modelNotice: false, suggestions: [], version: 0, announce: '' });
  }
  return s;
}

/** The full-tab address of the full-screen assistant, optionally opening a conversation. */
export function assistantUrl(conversationId = '') {
  const runtime = globalThis.chrome?.runtime;
  const url = new URL(runtime?.id && typeof runtime.getURL === 'function' ? runtime.getURL('index.html') : new URL('index.html', location.href));
  url.searchParams.set('libraryView', 'assistant');
  if (conversationId) url.searchParams.set('conversation', conversationId);
  return url.href;
}

// The constants both ends of the browser port share: the service worker's host (lib/browser/host.js) and the assistant's
// pages (lib/ai/browser-client.js, lib/ai/browser-tools.js). The messages themselves are described in host.js.

/** The name of the port a Still page opens to the browser host. */
export const BROWSER_PORT = 'still.browser.v1';
/** The layer tools a page may call. `upload` and `watch_download` are left out: the assistant has no file attachments yet. */
export const HOST_TOOLS = Object.freeze(['snapshot', 'find', 'read', 'screenshot', 'click', 'set', 'fill_form', 'type', 'press', 'hover', 'scroll', 'wait',
  'navigate', 'tabs', 'handle_dialog', 'ask_user']);
/** What the layer is told to keep an outline or a read to, so it cuts a long result itself and says so. */
export const RESULT_BUDGET = 7000;
/** A step handed to the person waits this long: they may be in another window. */
export const ASK_TIMEOUT_MS = 15 * 60_000;
/** The assistant's own labels. Page text that imitates them is defused by the layer before a model reads it. */
export const NOTE_LABELS = Object.freeze(['[Still note', 'browser-state', 'assistant-notes']);

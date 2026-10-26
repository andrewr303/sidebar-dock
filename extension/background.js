import {
  configureStoreWorker, handleStoreOperation, loadLibrary, saveItem, updateItem,
  createCollection, subscribe, STORAGE_KEY, canonicalUrl, safeUrl, saveAttachment, deleteAttachment,
} from './lib/store.js';
import { buildCapture, readPageMetadata } from './lib/capture.js';
import { assertCaptureTab, captureRateLimiter, captureFullPagePixels, checkCaptureCancelled, pngDataUrlBlob } from './lib/full-page-capture.js';

configureStoreWorker();

const api = globalThis.chrome;
let visibleScreenshotJobs = 0;
const REMINDER_PREFIX = 'still:reminder:';
const MENU_ITEMS = [
  { id: 'still-save-page', title: 'Save page to Still', contexts: ['page'], documentUrlPatterns: ['http://*/*', 'https://*/*'] },
  { id: 'still-save-link', title: 'Save link to Still', contexts: ['link'], targetUrlPatterns: ['http://*/*', 'https://*/*'] },
  { id: 'still-save-selection', title: 'Highlight selection in Still', contexts: ['selection'], documentUrlPatterns: ['http://*/*', 'https://*/*'] },
  { id: 'still-note-selection', title: 'Create a note from selection', contexts: ['selection'], documentUrlPatterns: ['http://*/*', 'https://*/*'] },
  { id: 'still-save-image', title: 'Save image to Still', contexts: ['image'], targetUrlPatterns: ['http://*/*', 'https://*/*'] },
  { id: 'still-screenshot', title: 'Save a screenshot to Still', contexts: ['action'] },
  { id: 'still-screenshot-full', title: 'Save full-page screenshot to Still', contexts: ['page', 'action'], documentUrlPatterns: ['http://*/*', 'https://*/*'] },
  { id: 'still-open-library', title: 'Open Still in a new tab', contexts: ['action'] },
];

function reportError(error) {
  console.error('Still:', error?.message || String(error));
  api.action?.setBadgeText({ text: '!' });
  api.action?.setBadgeBackgroundColor({ color: '#bc6666' });
}

export async function installMenus() {
  await api.contextMenus.removeAll();
  for (const item of MENU_ITEMS) await api.contextMenus.create(item);
}

export function openLibrary(itemId = '') {
  const target = api.runtime.getURL(`index.html${itemId ? `?item=${encodeURIComponent(itemId)}` : ''}`);
  return api.tabs.create({ url: target });
}

function openSidePanel(tab) {
  if (Number.isInteger(tab?.windowId)) return api.sidePanel.open({ windowId: tab.windowId });
  if (Number.isInteger(tab?.id)) return api.sidePanel.open({ tabId: tab.id });
  return Promise.resolve();
}

async function activeTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) throw new Error('No active browser tab was found.');
  return tabs[0];
}

export async function captureTab(tab, info = {}) {
  let metadata = {};
  if (!info.linkUrl && !info.srcUrl && Number.isInteger(tab?.id) && /^https?:\/\//i.test(tab.url || info.pageUrl || '')) {
    try {
      const result = await api.scripting.executeScript({ target: { tabId: tab.id }, func: readPageMetadata });
      metadata = result?.[0]?.result || {};
    } catch (error) {
      // URL/title capture remains possible when a site disallows DOM access.
      metadata = { title: tab.title, url: tab.url };
      console.info('Still saved tab metadata; page content could not be read:', error?.message);
    }
  }
  const input = buildCapture(info, tab, metadata);
  if (input.type === 'note') {
    const state = await loadLibrary();
    const linked = state.items.find(item => !item.deletedAt && item.type !== 'note' && canonicalUrl(item.url) === canonicalUrl(input.url));
    if (linked) input.relatedIds = [linked.id];
  }
  const item = await saveItem(input);
  await api.action.setBadgeText({ text: '✓' });
  await api.action.setBadgeBackgroundColor({ color: '#718a77' });
  await api.alarms.create('still:clear-badge', { when: Date.now() + 4000 });
  return item;
}

export async function captureScreenshot(tab, { persistAttachment = saveAttachment, removeAttachment = deleteAttachment, persistItem = saveItem, limiter = captureRateLimiter } = {}) {
  const sourceUrl = safeUrl(tab?.url, { optional: false });
  if (activeFullPageJob) throw new Error('Wait for the full-page screenshot to finish or cancel it first.');
  visibleScreenshotJobs++;
  try {
    const dataUrl = await limiter(() => api.tabs.captureVisibleTab(tab.windowId, { format: 'png' }), undefined, () => assertCaptureTab(api, tab));
    // captureVisibleTab targets a window, so do not attach a changed tab's pixels to the old page.
    await assertCaptureTab(api, tab);
    const file = pngDataUrlBlob(dataUrl);
    Object.defineProperty(file, 'name', { value: `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png` });
    const attachment = await persistAttachment(file);
    let item;
    try {
      item = await persistItem({ type: 'image', title: `Screenshot of ${tab.title || new URL(sourceUrl).hostname}`, url: '', sourceUrl,
        excerpt: 'Visible page screenshot', content: '', articleContent: '', cover: dataUrl, ...attachment });
    } catch (error) {
      try { await removeAttachment(attachment.attachmentId); }
      catch (cleanupError) { throw new Error(`${error.message} Screenshot file cleanup also failed: ${cleanupError.message}`); }
      throw error;
    }
    return item;
  } finally { visibleScreenshotJobs--; }
}

const fullPageJobs = new Map();
let activeFullPageJob = null;

function publishCaptureProgress(job, progress, runtime = api.runtime) {
  job.status = progress.status;
  job.progress = { ...job.progress, ...progress, jobId: job.id };
  // Opening/closing an extension view is independent of the owned capture job.
  try { Promise.resolve(runtime.sendMessage?.({ type: 'still:full-page-progress', ...job.progress })).catch(() => {}); }
  catch { /* No receiving view. */ }
}

export function getFullPageCaptureJob(jobId) {
  const job = jobId ? fullPageJobs.get(jobId) : activeFullPageJob;
  return job ? { ...job.progress, jobId: job.id, status: job.status } : null;
}

export function cancelFullPageCapture(jobId) {
  const job = fullPageJobs.get(jobId);
  const canCancel = job && !['saving', 'saved', 'error', 'cancelled'].includes(job.status) && !job.controller.signal.aborted;
  if (canCancel) job.controller.abort(new Error('Full-page capture cancelled.'));
  return { jobId, cancelled: Boolean(canCancel), status: job?.status || 'unknown' };
}

// Keep the handle while work is pending; the runtime message listener below
// returns true until this promise resolves, keeping the worker response alive.
export function startFullPageCapture(tab, { jobId = crypto.randomUUID(), persistAttachment = saveAttachment, removeAttachment = deleteAttachment,
  persistItem = saveItem, capturePixels = captureFullPagePixels, captureApi = api, limiter = captureRateLimiter, timeoutMs = 120_000, ...pixelOptions } = {}) {
  if (typeof jobId !== 'string' || !/^[a-z\d][a-z\d_-]{7,79}$/i.test(jobId)) throw new Error('Invalid full-page capture job ID.');
  if (activeFullPageJob) throw new Error('A full-page screenshot is already running.');
  if (visibleScreenshotJobs) throw new Error('Wait for the visible screenshot to finish before capturing the full page.');
  if (fullPageJobs.has(jobId)) throw new Error('This capture job ID has already been used.');
  // A runtime request registers its handle before resolving the active tab, so
  // a Cancel arriving during tabs.query cannot race ahead of job ownership.
  if (!tab?.then) safeUrl(tab?.url, { optional: false });
  const job = { id: jobId, controller: new AbortController(), status: 'preparing', progress: {}, startedAt: Date.now() };
  // Retain a small number of status receipts, never the PNG/blob or library item.
  for (const [id, previous] of fullPageJobs) if (previous !== activeFullPageJob && (fullPageJobs.size >= 8 || Date.now() - previous.startedAt > 180_000)) fullPageJobs.delete(id);
  fullPageJobs.set(jobId, job); activeFullPageJob = job;
  const timer = setTimeout(() => {
    if (!['saving', 'saved'].includes(job.status)) job.controller.abort(new Error('Full-page capture timed out. Try a shorter page or visible screenshot.'));
  }, timeoutMs);
  const promise = (async () => {
    let attachment, committed = false;
    try {
      tab = { ...await tab };
      checkCaptureCancelled(job.controller.signal);
      const sourceUrl = safeUrl(tab?.url, { optional: false });
      const image = await capturePixels(tab, { ...pixelOptions, api: captureApi, jobId, signal: job.controller.signal, limiter,
        onProgress: progress => publishCaptureProgress(job, progress, captureApi.runtime) });
      checkCaptureCancelled(job.controller.signal);
      await assertCaptureTab(captureApi, tab);
      const file = image.blob;
      if (!(file instanceof Blob) || file.type !== 'image/png') throw new Error('Chrome did not produce a PNG full-page screenshot.');
      Object.defineProperty(file, 'name', { value: `full-page-${new Date().toISOString().replace(/[:.]/g, '-')}.png` });
      attachment = await persistAttachment(file);
      checkCaptureCancelled(job.controller.signal);
      // Recheck after IndexedDB work; never save a screenshot under a changed URL.
      await assertCaptureTab(captureApi, tab);
      checkCaptureCancelled(job.controller.signal);
      publishCaptureProgress(job, { status: 'saving', completed: image.tileCount, total: image.tileCount, width: image.width, height: image.height }, captureApi.runtime);
      const item = await persistItem({ type: 'image', title: `Full-page screenshot of ${tab.title || new URL(sourceUrl).hostname}`, url: '', sourceUrl,
        excerpt: `${image.width} × ${image.height} PNG · ${image.tileCount} ${image.tileCount === 1 ? 'tile' : 'tiles'}`, content: '', articleContent: '', cover: image.cover, ...attachment });
      committed = true;
      publishCaptureProgress(job, { status: 'saved', itemId: item.id, completed: image.tileCount, total: image.tileCount, width: image.width, height: image.height }, captureApi.runtime);
      return { id: item.id, item, jobId, width: image.width, height: image.height, tileCount: image.tileCount };
    } catch (error) {
      let failure = error;
      if (attachment && !committed) {
        try { await removeAttachment(attachment.attachmentId); }
        catch (cleanupError) { failure = new Error(`${error.message} Screenshot file cleanup also failed: ${cleanupError.message}`); }
      }
      publishCaptureProgress(job, { status: job.controller.signal.aborted && /cancelled/i.test(job.controller.signal.reason?.message || '') ? 'cancelled' : 'error', message: failure.message }, captureApi.runtime);
      throw failure;
    } finally {
      clearTimeout(timer);
      if (activeFullPageJob === job) activeFullPageJob = null;
    }
  })();
  return { id: jobId, promise, cancel: () => cancelFullPageCapture(jobId) };
}

export function captureFullPage(tab, options) { return startFullPageCapture(tab, options).promise; }

async function syncReminders(state) {
  const currentAlarms = await api.alarms.getAll();
  const needed = new Map(state.items.filter(item => item.reminderAt && !item.deletedAt && !item.reminderNotifiedAt)
    .map(item => [REMINDER_PREFIX + item.id, Math.max(Date.now() + 1000, new Date(item.reminderAt).getTime())]));
  for (const alarm of currentAlarms) if (alarm.name.startsWith(REMINDER_PREFIX) && !needed.has(alarm.name)) await api.alarms.clear(alarm.name);
  for (const [name, when] of needed) {
    const existing = currentAlarms.find(alarm => alarm.name === name);
    if (!existing || Math.abs(existing.scheduledTime - when) > 1000) await api.alarms.create(name, { when });
  }
}

async function restoreReminders() {
  const stored = (await api.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (stored) await syncReminders(stored);
}

export async function handleAlarm(alarm) {
  if (alarm.name === 'still:clear-badge') { await api.action.setBadgeText({ text: '' }); return; }
  if (!alarm.name.startsWith(REMINDER_PREFIX)) return;
  const id = alarm.name.slice(REMINDER_PREFIX.length);
  const state = await loadLibrary();
  const item = state.items.find(value => value.id === id);
  if (!item || item.deletedAt || !item.reminderAt || item.reminderNotifiedAt) return;
  if (new Date(item.reminderAt).getTime() > Date.now() + 1000) return;
  await api.notifications.create(`still:item:${id}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: item.title,
    message: item.excerpt || 'A little reminder from your Still library.', priority: 1 });
  await updateItem(id, { reminderNotifiedAt: new Date().toISOString() });
}

async function importBrowserBookmarks() {
  if (!(await api.permissions.contains({ permissions: ['bookmarks'] }))) throw new Error('Allow bookmark access in Settings before importing.');
  const roots = await api.bookmarks.getTree();
  let imported = 0;
  async function walk(nodes, collectionId = '') {
    for (const node of nodes) {
      if (node.url) {
        if (!/^https?:\/\//i.test(node.url)) continue;
        await saveItem({ type: 'bookmark', title: node.title, url: node.url, collectionId }); imported++;
      } else if (node.children) {
        const collection = node.title ? await createCollection({ name: node.title, parentId: collectionId }) : null;
        await walk(node.children, collection?.id || collectionId);
      }
    }
  }
  await walk(roots);
  return { imported };
}

export async function handleMessage(message, sender) {
  if (!sender || sender.id !== api.runtime.id) throw new Error('Untrusted extension message.');
  if (!message || typeof message !== 'object') throw new Error('Invalid request.');
  if (message.type === 'still:store') return handleStoreOperation(message.operation, message.args);
  if (['captureCurrent', 'saveCurrentTab', 'still:capture-current'].includes(message.type)) return captureTab(await activeTab());
  if (['captureScreenshot', 'still:capture-screenshot'].includes(message.type)) return captureScreenshot(await activeTab());
  if (message.type === 'captureFullPage') return captureFullPage(activeTab(), { jobId: message.jobId });
  if (message.type === 'cancelFullPageCapture') return cancelFullPageCapture(message.jobId);
  if (message.type === 'getFullPageCaptureJob') return getFullPageCaptureJob(message.jobId);
  if (['openLibrary', 'still:open-library'].includes(message.type)) return openLibrary(typeof message.itemId === 'string' ? message.itemId : '');
  if (['openSidePanel', 'still:open-sidepanel'].includes(message.type)) return openSidePanel(sender.tab || await activeTab());
  if (['newNote', 'still:new-note'].includes(message.type)) return saveItem({ type: 'note', title: 'Untitled note', content: '' });
  if (message.type === 'importBrowserBookmarks') return importBrowserBookmarks();
  throw new Error('Unknown Still request.');
}

if (api?.runtime?.onMessage) {
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !['still:store', 'captureCurrent', 'saveCurrentTab', 'still:capture-current', 'captureScreenshot', 'still:capture-screenshot', 'captureFullPage', 'cancelFullPageCapture', 'getFullPageCaptureJob', 'openLibrary', 'still:open-library',
      'openSidePanel', 'still:open-sidepanel', 'newNote', 'still:new-note', 'importBrowserBookmarks'].includes(message.type)) return false;
    const respond = response => { try { sendResponse(response); } catch { /* The requesting view closed. */ } };
    handleMessage(message, sender).then(result => respond({ ok: true, result }), error => respond({ ok: false, error: error.message }));
    return true;
  });
  api.runtime.onInstalled.addListener(() => {
    installMenus().catch(reportError);
    api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(reportError);
    // The UI seeds a new library; installing does not overwrite existing captures.
  });
  api.runtime.onStartup.addListener(() => {
    api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(reportError);
    restoreReminders().catch(reportError);
  });
  api.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'still-open-library') { openLibrary().catch(reportError); return; }
    // Side panel open is invoked directly inside the user gesture, before capture awaits.
    const panelOpening = openSidePanel(tab).catch(reportError);
    if (info.menuItemId === 'still-screenshot') { captureScreenshot(tab).catch(reportError); return; }
    if (info.menuItemId === 'still-screenshot-full') { panelOpening.then(() => captureFullPage(tab)).catch(reportError); return; }
    captureTab(tab, info).catch(reportError);
  });
  api.commands.onCommand.addListener(command => {
    if (command === 'open-library') { openLibrary().catch(reportError); return; }
    if (command === 'new-note') {
      saveItem({ type: 'note', title: 'Untitled note' }).then(item => openLibrary(item.id)).catch(reportError); return;
    }
    if (command === 'save-current') activeTab().then(tab => captureTab(tab)).catch(reportError);
  });
  api.alarms.onAlarm.addListener(alarm => { handleAlarm(alarm).catch(reportError); });
  api.notifications.onClicked.addListener(id => {
    if (id.startsWith('still:item:')) openLibrary(id.slice('still:item:'.length)).catch(reportError);
    api.notifications.clear(id);
  });
  subscribe(state => { syncReminders(state).catch(reportError); });
  restoreReminders().catch(reportError);
}

export { MENU_ITEMS, STORAGE_KEY };

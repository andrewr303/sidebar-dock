// Added to the service worker of the copy of the extension that scripts/e2e-browser.mjs loads, never to the extension
// itself: it opens the driver page once, which runs the checks and reports to the local server.
const KEY = 'still.e2e.driver';
chrome.storage.session.get(KEY).then(stored => {
  if (stored[KEY]) return null;
  return chrome.storage.session.set({ [KEY]: true }).then(() => chrome.tabs.create({ url: chrome.runtime.getURL('e2e/driver.html'), active: true }));
}).catch(error => console.error('Still e2e:', error?.message || String(error)));

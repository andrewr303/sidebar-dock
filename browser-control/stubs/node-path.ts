// Stands in for `node:path` in the bundle. puppeteer-core imports it only to resolve a browser channel's profile
// folder (the `channel` option of connect()), which the layer never uses: it connects through chrome.debugger.
export const join = (...parts: string[]): string => parts.join('/');
export default { join };

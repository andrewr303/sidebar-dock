// The entry of the generated bundle, extension/lib/browser-control/layer.js.
//
// The service worker must import its modules statically, so it imports the bundle on every start. Nothing of the layer
// runs then: esbuild turns the two dynamic imports below into lazy initializers inside the one file, and the layer
// (Puppeteer, zod, the controller) is evaluated only when the assistant first asks for the browser.
export async function loadBrowserControl() {
  // zod tests whether it may compile parsers with `new Function` before it builds its first object schema. The
  // extension's content security policy refuses that, so it is told before the layer's schemas are evaluated.
  const { config } = await import('zod');
  config({ jitless: true });
  return import('./src/index');
}

# Browser control layer

This folder is the browser control layer of [Still Agent](https://github.com/andrewr303/still-agent), the part that lets the Still assistant work in a browser tab. It observes a page, acts on it with real input, and reports what happened. It has no model in it: the same request gives the same result. The assistant sits above it (`extension/lib/ai/`), and the service worker hosts it (`extension/lib/browser/`).

`src/` is Still Agent's `src/browser-control` at commit `5b4d161f99ba91c94651e6eac78e73ae1d4222ea`, copied without changes, with its unit tests. It is TypeScript and depends on `puppeteer-core` (the frame manager, connected through `chrome.debugger`) and `zod` (argument schemas). The extension itself stays plain JavaScript with no build step, so this folder is built into three committed files:

| File | What it is |
| --- | --- |
| `extension/lib/browser-control/layer.js` | The layer, puppeteer-core and zod as one ES module, about 775 KB. The service worker imports it, and nothing in it runs until the assistant first uses the browser. |
| `extension/lib/browser-control/catalogue.js` | The layer's tools as data: names, descriptions and argument schemas. The assistant builds its tool definitions from it. |
| `extension/assets/licenses/browser-control.txt` | The licence notices for the code inside `layer.js`. |

`scripts/generated.json` holds their pins (byte length and SHA-256) and a hash of everything the build read from this folder. `node scripts/check.mjs` in the repository root compares both, so a change here that was not built again fails the check, and so does an edit to a built file. Loading the extension needs none of this: the built files are in the repository.

## Working on the layer

Use Node.js 22 or later. Install the pinned packages once, then build, test and check from this folder:

```bash
npm ci
```

```bash
npm run build
```

```bash
npm test
```

```bash
npm run type-check
```

```bash
npm run check
```

`npm run build` writes the three files and the pins. `npm test` runs the layer's unit tests (pure functions over recorded CDP payloads). `npm run check` builds in memory and fails when a committed file differs from the build. With npm 10, a first `npm install` without the lockfile can fail on a peer-dependency error in npm itself; `npm ci` with the committed lockfile works.

What needs a browser is checked from the repository root by `node scripts/e2e-browser.mjs`, which loads the extension in Chrome and drives the assistant against local pages.

## The rules of the layer

They come from Still Agent and still hold here.

- `chrome.debugger` is the only way to reach the Chrome DevTools Protocol. There is no WebSocket connection and no remote browser.
- Puppeteer tracks frames, including out-of-process iframes. Elements are never found through Puppeteer: an action goes to the node the assistant was shown, by the browser's own handle for it.
- A ref is valid only for the document it was seen in. Otherwise the result is a typed error, not a guess.
- Input is sent once. The result says whether it was dispatched, whether the page reacted, and whether the expected state was reached.
- Observation does not change the page. Partial captures and cuts are stated in the result.
- An action classified as submit, pay or delete is not sent until the person allows it, and nothing a model sends can turn that off.
- Nothing outside the extension can drive the layer. The local bridge and its MCP server have no path to it.

## What the build leaves out

Two parts of the dependencies that the layer cannot reach are replaced by small stand-ins, which takes almost half off the file the service worker parses when it starts: Puppeteer's WebDriver BiDi support (the layer always connects with CDP) and zod's error messages in languages other than English. `build.mjs` checks that the replaced files still look as expected and that the layer still connects with CDP, so an upgrade that changes either fails the build.

## Licence

The layer is licensed under the Apache License, Version 2.0 (`LICENSE`), with the attribution in `NOTICE`. The packages inside the built file keep their own licences, listed in `extension/assets/licenses/browser-control.txt`.

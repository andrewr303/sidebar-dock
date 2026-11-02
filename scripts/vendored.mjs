// Third-party files shipped unmodified inside extension/. check.mjs and both packaging scripts verify these pins, so a
// vendored file can only change together with this list (and its provenance in the license file).
export const VENDORED_FILES = [
  {
    path: 'lib/vendor/readability.js',
    bytes: 90944,
    sha256: 'e9330028c8a5a4aa7d75147be2605d520f7f213c7b28474947dc0e9c984e9bed',
    license: 'assets/licenses/readability.txt',
    source: 'mozilla/readability Readability.js at ab4027a8b37669745016869a37a504727992b2ba (Apache-2.0)',
  },
];

// Classic scripts that the worker injects into web pages with executeScript({ files }). They run in the page's isolated
// world, not as modules: no import or export, and no extension module may import them.
export const CLASSIC_SCRIPT_DIRS = ['content/', 'lib/vendor/'];

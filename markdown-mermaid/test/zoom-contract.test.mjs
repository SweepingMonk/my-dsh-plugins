// Static regression guards for the Desktop overlay integration contract.
// These do not emulate DOM hit testing or replace a native Desktop click test.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/client.jsx', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

assert.match(source, /import \{ createPortal \} from 'react-dom'/u);
assert.match(source, /return createPortal\(<dialog\b/u, 'dialog must leave the Markdown DOM subtree');
assert.match(source, /<\/dialog>, document\.body\)/u, 'portal must mount directly in body');
assert.match(source, /data-window-drag-exclude=""/u, 'declare the host Desktop drag exclusion');
assert.match(source, /node\.showModal\(\)/u, 'retain native modality and keyboard focus containment');
assert.match(source, /previousFocus\.focus\(\{ preventScroll: true \}\)/u, 'retain focus restoration');
assert.match(source, /onClose=\{onClose\}/u, 'native close must synchronize component state');
assert.match(source, /onClick=\{event => \{ event\.stopPropagation\(\)/u, 'portal clicks must not escape into the owner tree');

const css = source.match(/const css = `([\s\S]*?)`;/u)?.[1];
assert.ok(css, 'plugin stylesheet must be present');
assert.match(css, /\.local-mm-zoom-dialog\{[^}]*position:fixed;[^}]*inset:var\(--dsh-frame-overlay-top,20px\) 0 20px/u);
assert.match(css, /height:calc\(100dvh - var\(--dsh-frame-overlay-top,20px\) - 20px\)/u, 'height must account for the same top safe area');
assert.match(css, /margin:0 auto/u, 'override native dialog auto vertical centering');
assert.match(css, /\.local-mm-zoom-dialog,\.local-mm-zoom-dialog \*\{-webkit-app-region:no-drag\}/u);
assert.match(css, /\.local-mm-zoom-viewport\{[^}]*overflow:auto;flex:1;min-height:0/u, 'only the image viewport should scroll');
for (const contract of ['data-window-drag-exclude', '--dsh-frame-overlay-top', '-webkit-app-region:no-drag']) {
  assert.ok(bundle.includes(contract), `build must contain ${contract}`);
}
assert.ok(bundle.includes(pkg.version), 'build must carry the current package version');
console.log('Desktop zoom overlay contract: OK (static; native clicks require Desktop verification)');

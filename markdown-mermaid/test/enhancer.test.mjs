// Loads the built client.js with a stub module loader and a minimal fake DOM,
// then exercises the enhancer's create / re-render / teardown paths.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parent = null;
    this.attrs = new Set();
    this.dataset = new Proxy({}, { set: (t, k, v) => { t[k] = v; this.attrs.add(kebab(k)); return true; }, deleteProperty: (t, k) => { delete t[k]; this.attrs.delete(kebab(k)); return true; }, get: (t, k) => t[k] });
    this._text = '';
  }
  get parentElement() { return this.parent; }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get nextElementSibling() {
    const siblings = this.parent?.children ?? [];
    const index = siblings.indexOf(this);
    return index >= 0 ? siblings[index + 1] ?? null : null;
  }
  get previousElementSibling() {
    const siblings = this.parent?.children ?? [];
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1] : null;
  }
  get isConnected() { let node = this; while (node.parent) node = node.parent; return node === document.body; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = value; this.children = []; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  after(node) {
    const siblings = this.parent.children;
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
    node.parent = this.parent;
  }
  remove() { if (!this.parent) return; const siblings = this.parent.children; siblings.splice(siblings.indexOf(this), 1); this.parent = null; }
  matches(selector) { return match(this, selector); }
  closest(selector) { let node = this; while (node) { if (match(node, selector)) return node; node = node.parent; } return null; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const found = [];
    const walk = node => { for (const child of node.children) { if (match(child, selector)) found.push(child); walk(child); } };
    walk(this);
    return found;
  }
}
function kebab(key) { return `data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`; }
function match(node, selector) {
  if (selector.startsWith('.')) return (node.classList ?? []).includes(selector.slice(1));
  const attr = /^\[([\w-]+)\]$/.exec(selector);
  if (attr) return node.attrs.has(attr[1]);
  return node.tagName === selector;
}
globalThis.Element = El;
globalThis.document = {
  body: new El('body'),
  head: new El('head'),
  createElement: tag => new El(tag),
  querySelectorAll: selector => document.body.querySelectorAll(selector),
  querySelector: selector => document.body.querySelector(selector),
};
document.head.append = function (...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } };
const timers = new Map();
let timerId = 0;
globalThis.window = {
  setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
  clearTimeout: (id) => timers.delete(id),
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const flushTimers = () => { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); };

class FakeObserver {
  constructor(callback) { this.callback = callback; FakeObserver.instance = this; }
  observe() {}
  disconnect() { FakeObserver.instance = null; }
}
globalThis.MutationObserver = FakeObserver;

let factory;
globalThis.window.__ModuleLoader__ = { load: registration => { factory = registration.factory; } };
const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
new Function('window', 'document', 'Element', 'MutationObserver', 'queueMicrotask', bundle)(globalThis.window, globalThis.document, El, FakeObserver, queueMicrotask);

const renders = [];
const unmounts = [];
const requireStub = spec => {
  if (spec === 'react') return { createElement: (type, props) => ({ type, props }), Fragment: 'fragment', useRef: () => ({}), useState: () => [null, () => {}], useEffect: () => {}, useMemo: () => null };
  if (spec === 'react-dom') return { createPortal: () => { throw new Error('enhancer-only test must not mount zoom UI'); } };
  if (spec === 'react-dom/client') return { createRoot: host => ({ render: element => renders.push({ host, element }), unmount: () => unmounts.push(host) }) };
  throw new Error(`unexpected require ${spec}`);
};
const client = factory(requireStub);
assert.deepEqual(client.inject, ['locale', 'theme'], 'client services the plugin waits for');

// --- build the Host's rendered Markdown shape ---
const root = new El('div'); root.dataset.documentMarkdown = true;
const markdown = new El('div');
root.append(markdown);
document.body.append(root);
/** Attach a fake React fiber so the enhancer can read the authored fence language. */
const setLang = (block, lang) => { block['__reactFiber$test'] = { memoizedProps: {}, return: { memoizedProps: { lang } } }; };
const block = (lang, code) => {
  const b = new El('div'); b.classList = ['md-code-block'];
  const banner = new El('div'); banner.attrs.add('data-code-block-banner');
  const label = new El('div'); label.textContent = 'code block';
  banner.append(label);
  const content = new El('div'); content.attrs.add('data-code-block-content');
  const pre = new El('pre'); pre.textContent = `${code} `;
  content.append(pre);
  b.append(banner, content);
  if (lang !== null) setLang(b, lang);
  markdown.append(b);
  return b;
};
const a = block('mermaid', 'graph TD\nA-->B');
const js = block('js', 'const x = 1');
const sniffed = block(null, 'flowchart LR\nX-->Y');
const plain = block(null, 'SELECT 1');
const c = block('mermaid', 'sequenceDiagram\nU->>P: hi');

// --- activate ---
const disposers = [];
const ctx = {
  locale: { register: () => () => {}, bind: () => key => key },
  theme: { getTheme: () => ({ active: { colorScheme: 'light' }, revision: 0 }) },
  get: () => undefined,
  on: () => () => {},
  effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
};
client.apply(ctx, {});

// 1. fiber language wins; content sniff rescues blocks without a fiber
assert.equal(a.dataset.mmHidden, '', 'mermaid fence must be hidden');
assert.equal(c.dataset.mmHidden, '', 'second mermaid fence must be hidden');
assert.equal(sniffed.dataset.mmHidden, '', 'fiber-less fence is detected by its diagram type');
assert.equal(js.dataset.mmHidden, undefined, 'a js fence must stay visible');
assert.equal(plain.dataset.mmHidden, undefined, 'a non-mermaid fence without a fiber must stay visible');
assert.equal(renders.length, 3, `expected 3 renders, got ${renders.length}`);
const first = renders.find(r => r.element.props.source === 'graph TD\nA-->B');
const second = renders.find(r => r.element.props.source === 'sequenceDiagram\nU->>P: hi');
assert.ok(first, 'the first diagram must render its trimmed source');
assert.equal(first.element.props.settled, true, 'a block followed by another block settles immediately');
assert.equal(second.element.props.settled, false, 'a trailing block must wait for quiet');
flushTimers();
assert.equal(renders.filter(r => r.element.props.source.startsWith('sequenceDiagram')).at(-1).element.props.settled, true, 'trailing block settles after the quiet period');

// 2. streamed text re-renders with the new source
const cPre = c.querySelector('[data-code-block-content]').querySelector('pre');
cPre.textContent = 'sequenceDiagram\nU->>P: hi\nP-->>U: ok ';
FakeObserver.instance.callback([{ type: 'characterData', target: cPre, addedNodes: [], removedNodes: [] }]);
await tick();
assert.ok(renders.some(r => r.element.props.source.includes('P-->>U: ok')), 'updated fence content must re-render');

// 3. a block React kept but re-labelled stops (and starts) being enhanced
setLang(js, 'mermaid');
FakeObserver.instance.callback([{ type: 'childList', target: markdown, addedNodes: [], removedNodes: [] }]);
await tick();
assert.equal(js.dataset.mmHidden, '', 're-labelled block becomes a diagram');
assert.equal(unmounts.length, 0);
setLang(js, 'python');
FakeObserver.instance.callback([{ type: 'childList', target: markdown, addedNodes: [], removedNodes: [] }]);
await tick();
assert.equal(js.dataset.mmHidden, undefined, 'teardown must un-hide the block');
assert.equal(unmounts.length, 1, 'teardown must unmount its root');

// 4. a removed block takes its host and root with it
const aHost = a.nextElementSibling;
markdown.children.splice(markdown.children.indexOf(a), 1);
a.parent = null;
FakeObserver.instance.callback([{ type: 'childList', target: markdown, addedNodes: [], removedNodes: [a] }]);
await tick();
assert.equal(aHost.isConnected, false, 'host must be removed with its block');
assert.equal(unmounts.length, 2, 'removed block must unmount its root');

// 5. disposing the plugin cleans everything up
for (const dispose of disposers) dispose();
assert.equal(FakeObserver.instance, null, 'observer must be disconnected');
assert.equal(markdown.querySelectorAll('[data-mm-host]').length, 0, 'no host may survive disposal');
console.log('enhancer state machine: OK');

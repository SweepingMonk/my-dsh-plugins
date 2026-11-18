import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';

const NS = 'localMarkdownMermaid';
const VERSION = typeof __PLUGIN_VERSION__ === 'undefined' ? '0.0.0' : __PLUGIN_VERSION__;
/** The literal class the Host's Markdown primitive puts on every fenced code block. */
const BLOCK_CLASS = 'md-code-block';
/** Quiet period applied to a fence that is still the last block of its container. */
const SETTLE_MS = 250;
const dictionaries = {
  en: { loading: 'Rendering Mermaid diagram…', error: 'Unable to render this Mermaid diagram. Check its syntax below.', source: 'Mermaid source', diagram: 'Mermaid diagram', incomplete: 'Waiting for the rest of this diagram…', tooLarge: 'Diagram exceeds the 50,000-character preview limit.', enlarge: 'Enlarge preview', close: 'Close', zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit to window', actual: 'Actual size', zoomHint: 'Scroll to pan · Ctrl/⌘ + wheel to zoom · Esc to close' },
  zh: { loading: '正在渲染 Mermaid 图表…', error: 'Mermaid 图表渲染失败，请检查下方语法。', source: 'Mermaid 源码', diagram: 'Mermaid 图表', incomplete: '等待图表内容加载完整…', tooLarge: '图表超过 50,000 字符的预览限制。', enlarge: '放大预览', close: '关闭', zoomIn: '放大', zoomOut: '缩小', fit: '适应窗口', actual: '原始大小', zoomHint: '滚动平移 · Ctrl/⌘ + 滚轮缩放 · Esc 关闭' },
};
const css = `
.md-code-block[data-mm-hidden]{display:none!important}
.local-mm-diagram{position:relative;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin:12px 0;padding:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;line-height:1.6}
.local-mm-diagram img{display:block;margin:auto;max-width:100%}
.local-mm-diagram pre{white-space:pre;overflow:auto;margin:8px 0 0;padding:10px;border-radius:6px;background:var(--dsw-alias-bg-base);font:12px/1.6 ui-monospace,monospace}
.local-mm-diagram details{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.local-mm-diagram summary{cursor:pointer}
.local-mm-diagram [role=status]{color:var(--dsw-alias-label-secondary)}
.local-mm-diagram [role=alert]{color:var(--dsw-alias-state-error-primary)}
.local-mm-measure{position:absolute;visibility:hidden;pointer-events:none;inset-inline-start:0;top:0;width:100%;overflow:hidden}
.local-mm-button{font:inherit;font-size:12px;line-height:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 10px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);cursor:pointer}
.local-mm-button:hover{background:var(--dsw-alias-bg-layer-2)}
.local-mm-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.local-mm-button:disabled{opacity:.45;cursor:default}
.local-mm-image-button{display:block;width:100%;border:0;background:transparent;padding:0;cursor:zoom-in}
.local-mm-diagram-toolbar{display:flex;justify-content:flex-end;margin-bottom:8px}
/* Desktop drag regions are native hit-test geometry, not z-index layers. Keep
   this body-level portal after #root and below the host's window chrome. */
.local-mm-zoom-dialog{position:fixed;inset:var(--dsh-frame-overlay-top,20px) 0 20px;box-sizing:border-box;width:calc(100% - 40px);height:calc(100dvh - var(--dsh-frame-overlay-top,20px) - 20px);max-width:1800px;max-height:none;margin:0 auto;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font-family:var(--dsw-font-family,inherit);line-height:1.6;overflow:hidden}
.local-mm-zoom-dialog,.local-mm-zoom-dialog *{-webkit-app-region:no-drag}
.local-mm-zoom-dialog::backdrop{background:var(--dsw-alias-bg-overlay);opacity:.8}
.local-mm-zoom-layout{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0}
.local-mm-zoom-toolbar{position:relative;z-index:1;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:none}
.local-mm-zoom-title{font-size:14px;margin-right:auto}
.local-mm-zoom-percent{font-size:12px;min-width:44px;text-align:center;font-variant-numeric:tabular-nums}
.local-mm-zoom-viewport{overflow:auto;flex:1;min-height:0;overscroll-behavior:contain;background:var(--dsw-alias-bg-base)}
.local-mm-zoom-surface{box-sizing:content-box;min-width:100%;min-height:100%;display:flex}
.local-mm-zoom-dialog .local-mm-zoom-image{display:block;flex:none;max-width:none;max-height:none;object-fit:contain;margin:auto;user-select:none}
.local-mm-zoom-hint{padding:6px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1)}
`;
const diagnostics = new Map();
const zoomDiagnostics = new Map();
let serial = 0;
let queue = Promise.resolve();
let mermaidModule;
/**
 * The font this Markdown is rendered in: the General settings body font reaches the
 * block through `--dsw-font-family`, and the diagram must use the same stack. The
 * SVG is displayed as an image, where locally installed system fonts still resolve.
 */
function resolvedFontFamily(element) {
  const inherited = getComputedStyle(element).fontFamily?.trim();
  if (inherited !== undefined && inherited !== '') return inherited;
  const body = document.body === null ? '' : getComputedStyle(document.body).fontFamily?.trim();
  return body || 'sans-serif';
}
function renderDiagram(source, container, palette, fontFamily) {
  const task = queue.then(async () => {
    if (!container.isConnected) return null;
    mermaidModule ??= import('mermaid').then(m => m.default);
    const mermaid = await mermaidModule;
    if (!container.isConnected) return null;
    try {
      // Resolve inherited theme variables on our mounted element, not on <html>.
      // Mermaid's color parser cannot consume empty strings, light-dark(), or color().
      const style = getComputedStyle(container);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { colorSpace: 'srgb' });
      const color = name => {
        const value = style.getPropertyValue(name).trim();
        if (!value || !context || !CSS.supports('color', value)) return undefined;
        // Canvas resolves CSS colors to sRGB pixels without entering the app DOM.
        // light-dark() is resolved by an inherited color property on the measuring element.
        container.style.color = `var(${name})`;
        const computed = getComputedStyle(container).color;
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = computed;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
        return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
      };
      const bg = color('--dsw-alias-bg-layer-1');
      const text = color('--dsw-alias-label-primary');
      const border = color('--dsw-alias-border-l2');
      const colors = bg && text && border ? { background: bg, primaryColor: bg, primaryTextColor: text, primaryBorderColor: border, secondaryColor: bg, tertiaryColor: bg, lineColor: text, textColor: text } : {};
      mermaid.initialize({
        startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
        maxTextSize: 50000, maxEdges: 500, theme: bg && text && border ? 'base' : palette.dark ? 'dark' : 'default',
        themeVariables: { darkMode: palette.dark, ...colors, fontFamily },
        htmlLabels: false, flowchart: { htmlLabels: false },
        secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'theme', 'themeVariables', 'flowchart', 'htmlLabels'],
      });
      const { svg } = await mermaid.render(`local-mm-${++serial}`, source, container);
      // Give the static SVG explicit intrinsic dimensions. Mermaid's responsive
      // width="100%" otherwise lets <img> fall back to browser default sizing.
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const root = parsed.documentElement;
      const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/u).map(Number);
      if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
        root.setAttribute('width', String(viewBox[2]));
        root.setAttribute('height', String(viewBox[3]));
        root.style.removeProperty('max-width');
        root.style.removeProperty('width');
        root.style.removeProperty('height');
      }
      // Static image context keeps diagram scripts and callbacks out of app DOM.
      return URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' }));
    } finally { container.replaceChildren(); }
  });
  queue = task.catch(() => {});
  return task;
}
function currentPalette(ctx) {
  const theme = ctx.theme.getTheme();
  return { dark: theme.active.colorScheme === 'dark', revision: theme.revision };
}
function ZoomPreview({ url, t, id, onClose }) {
  const dialog = useRef(null);
  const viewport = useRef(null);
  const image = useRef(null);
  const [size, setSize] = useState(null);
  const [bounds, setBounds] = useState({ width: 1, height: 1 });
  const [fitRevision, setFitRevision] = useState(0);
  const [preference, setPreference] = useState(null);
  const fit = size ? Math.min(8, Math.max(1, bounds.width - 32) / size.width, Math.max(1, bounds.height - 32) / size.height) : 1;
  const scale = preference ?? fit;
  const clamp = value => Math.max(.1, Math.min(8, value));
  const zoom = value => setPreference(clamp(value));
  const latest = useRef({ scale, zoom });
  latest.current = { scale, zoom };
  useEffect(() => {
    const node = dialog.current;
    const previousFocus = document.activeElement;
    node.showModal();
    return () => {
      node.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const node = viewport.current;
    const measure = () => setBounds({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    const wheel = event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1;
      latest.current.zoom(latest.current.scale * Math.exp(-Math.max(-80, Math.min(80, event.deltaY * factor)) * .01));
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); node.removeEventListener('wheel', wheel); };
  }, []);
  useEffect(() => {
    zoomDiagnostics.set(id, () => {
      const rectangle = image.current?.getBoundingClientRect();
      const port = viewport.current;
      return { open: true, scale: Math.round(scale * 100), mode: preference === null ? 'fit' : 'fixed', imageLoaded: size !== null, intrinsicSize: size, viewport: { width: port?.clientWidth, height: port?.clientHeight }, renderedSize: { width: rectangle?.width, height: rectangle?.height }, expectedSize: size ? { width: size.width * scale, height: size.height * scale } : null };
    });
    return () => zoomDiagnostics.delete(id);
  }, [id, scale, preference, size, bounds]);
  useEffect(() => {
    // Explicit dimensions avoid inherited Markdown image rules overriding zoom.
    const node = image.current;
    if (!size || !node) return;
    node.style.setProperty('width', `${size.width * scale}px`, 'important');
    node.style.setProperty('height', `${size.height * scale}px`, 'important');
    node.style.setProperty('max-width', 'none', 'important');
    node.style.setProperty('max-height', 'none', 'important');
    if (preference === null) { viewport.current.scrollLeft = 0; viewport.current.scrollTop = 0; }
  }, [size, scale, preference, fitRevision]);
  // A native top-layer dialog still participates in Electron's window drag
  // hit testing. Portal beside #root instead of leaving it inside Markdown.
  return createPortal(<dialog ref={dialog} className="local-mm-zoom-dialog" data-window-drag-exclude="" aria-label={t('enlarge')}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClose={onClose}
    onClick={event => { event.stopPropagation(); if (event.target === dialog.current) { const box = dialog.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose(); } }}>
    <div className="local-mm-zoom-layout">
      <div className="local-mm-zoom-toolbar" role="toolbar" aria-label={t('enlarge')}>
        <strong className="local-mm-zoom-title">{t('diagram')}</strong>
        <button type="button" className="local-mm-button" onClick={() => zoom(scale / 1.25)} disabled={scale <= .1} aria-label={t('zoomOut')}>−</button>
        <output className="local-mm-zoom-percent" aria-live="polite">{preference === null ? `${t('fit')} · ` : ''}{Math.round(scale * 100)}%</output>
        <button type="button" className="local-mm-button" onClick={() => zoom(scale * 1.25)} disabled={scale >= 8} aria-label={t('zoomIn')}>＋</button>
        <button type="button" className="local-mm-button" aria-pressed={preference === null} onClick={() => { setPreference(null); setFitRevision(value => value + 1); }}>{t('fit')}</button>
        <button type="button" className="local-mm-button" onClick={() => setPreference(1)}>{t('actual')}</button>
        <button type="button" className="local-mm-button" autoFocus onClick={onClose}>{t('close')} ×</button>
      </div>
      <div ref={viewport} className="local-mm-zoom-viewport" tabIndex={0} aria-label={t('diagram')}>
        <div className="local-mm-zoom-surface">
          <img ref={image} src={url} className="local-mm-zoom-image" alt={t('diagram')} draggable={false}
            style={size ? {} : { visibility: 'hidden' }}
            onLoad={event => { const node = event.currentTarget; if (node.naturalWidth && node.naturalHeight) setSize({ width: node.naturalWidth, height: node.naturalHeight }); }} />
        </div>
      </div>
      <div className="local-mm-zoom-hint">{t('zoomHint')}</div>
    </div>
  </dialog>, document.body);
}
function MermaidDiagram({ source, settled, palette, t, id }) {
  const container = useRef(null);
  const [result, setResult] = useState(null);
  const [enlarged, setEnlarged] = useState(false);
  useEffect(() => {
    setResult(null);
    const tooLarge = source.length > 50000;
    const fontFamily = resolvedFontFamily(container.current);
    diagnostics.set(id, { state: 'loading', type: source.split('\n')[0], characters: source.length, fontFamily });
    if (!settled || tooLarge) return () => diagnostics.delete(id);
    let active = true;
    let ownedUrl;
    renderDiagram(source, container.current, palette, fontFamily).then(url => {
      if (!url) return;
      if (!active) { URL.revokeObjectURL(url); return; }
      ownedUrl = url;
      diagnostics.set(id, { state: 'ready', type: source.split('\n')[0], characters: source.length, fontFamily });
      setResult({ source, palette, url });
    }).catch(error => {
      console.error('[Markdown Mermaid] render failed', error);
      if (active) {
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.set(id, { state: 'error', type: source.split('\n')[0], message, fontFamily });
        setResult({ source, palette, error: true, message });
      }
    });
    return () => { active = false; diagnostics.delete(id); if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
  }, [source, settled, palette, id]);
  const current = result?.source === source && result?.palette === palette ? result : null;
  const error = source.length > 50000 || current?.error;
  return <figure className="local-mm-diagram" data-mermaid-state={error ? 'error' : current?.url ? 'ready' : 'loading'} aria-label={t('diagram')}>
    <div ref={container} className="local-mm-measure" aria-hidden="true" />
    {current?.url ? <>
      <div className="local-mm-diagram-toolbar"><button type="button" className="local-mm-button" onClick={() => setEnlarged(true)}>{t('enlarge')} ⤢</button></div>
      <button type="button" className="local-mm-image-button" onClick={() => setEnlarged(true)} aria-label={t('enlarge')}><img src={current.url} alt={t('diagram')} /></button>
      {enlarged ? <ZoomPreview key={current.url} url={current.url} t={t} id={id} onClose={() => setEnlarged(false)} /> : null}
    </> : <div role={error ? 'alert' : 'status'}>{t(source.length > 50000 ? 'tooLarge' : error ? 'error' : settled ? 'loading' : 'incomplete')}</div>}
    {current?.message ? <pre role="note">{current.message}</pre> : null}
    <details open={error || undefined}><summary>{t('source')}</summary><pre><code>{source}</code></pre></details>
  </figure>;
}
/** Mermaid diagram types accepted at the start of a fence. */
const MERMAID_TYPE = /^(?:flowchart|graph|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|sankey-beta|xychart-beta|block-beta|packet-beta|kanban|architecture-beta|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|radar-beta|treemap-beta|zenuml)\b/u;
/**
 * Read the fence language the Host rendered. The visible header cannot answer
 * this: the Markdown primitive prints a generic "code block" label for any
 * language it cannot highlight, which includes mermaid. The rendered code
 * block's React props still carry the authored `lang`, so read them from the
 * owning fiber; React exposes it on the host node under a per-build key.
 */
function languageFromFiber(block) {
  let key;
  for (const candidate of Object.getOwnPropertyNames(block)) {
    if (candidate.startsWith('__reactFiber$') || candidate.startsWith('__reactInternalInstance$')) { key = candidate; break; }
  }
  if (key === undefined) return '';
  let fiber = block[key];
  for (let depth = 0; fiber !== undefined && depth < 8; depth += 1, fiber = fiber.return) {
    const lang = fiber.memoizedProps?.lang;
    if (typeof lang === 'string') return lang;
  }
  return '';
}
/** Fallback when the fiber is unavailable: does the fence open with a Mermaid diagram type? */
function looksLikeMermaid(source) {
  const lines = source.split('\n');
  let index = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, position) => position > 0 && (line.trim() === '---' || line.trim() === '...'));
    if (end > 0) index = end + 1;
  }
  while (index < lines.length) {
    const line = lines[index].trim();
    if (line !== '' && !line.startsWith('%%')) return MERMAID_TYPE.test(line);
    index += 1;
  }
  return false;
}
/** Fence content, minus the single trailing space the Markdown primitive appends. */
function sourceOf(block) {
  return (block.querySelector('[data-code-block-content]')?.textContent ?? '').replace(/ $/u, '');
}
/**
 * Whether this fence is the last content block of its container, counting the
 * sibling we inserted ourselves as part of the block. Only such a fence can
 * still be paged or streamed into, so only it has to wait for quiet.
 */
function isTrailing(block) {
  const last = block.parentElement?.lastElementChild;
  if (last === block) return true;
  return last?.dataset.mmHost !== undefined && last.previousElementSibling === block;
}
/**
 * Enhance the Host's already-rendered Markdown instead of replacing its renderer:
 * every `md-code-block` whose language is `mermaid` is hidden and followed by a
 * sibling node holding our React tree. React owns the block, so it is never
 * removed or replaced — only flagged and hidden — and every pass re-checks
 * connectivity so blocks React drops take their diagram with them.
 */
function startEnhancer(ctx, config) {
  const t = ctx.locale.bind(NS);
  const scope = config?.scope === 'preview' ? '[data-document-markdown]' : null;
  const selector = `.${BLOCK_CLASS}`;
  const entries = new Map();
  let palette = currentPalette(ctx);
  const styleName = '@local/markdown-mermaid/enhancer.css';
  document.querySelector(`style[data-plugin-css="${styleName}"]`)?.remove();
  const style = document.createElement('style');
  style.dataset.plugin = '@local/markdown-mermaid';
  style.dataset.pluginCss = styleName;
  style.textContent = css;
  document.head.append(style);
  const render = entry => {
    entry.root.render(<MermaidDiagram source={entry.source} settled={entry.settled} palette={palette} t={t} id={entry.id} />);
  };
  const teardown = block => {
    const entry = entries.get(block);
    if (!entry) return;
    entries.delete(block);
    window.clearTimeout(entry.timer);
    delete block.dataset.mmHidden;
    entry.root.unmount();
    entry.host.remove();
  };
  const consider = block => {
    if (!block.isConnected) return;
    if (scope !== null && !block.closest(scope)) return;
    const source = sourceOf(block);
    const lang = languageFromFiber(block);
    const mermaid = lang === '' ? looksLikeMermaid(source) : lang.trim().toLowerCase() === 'mermaid';
    if (!mermaid) { teardown(block); return; }
    if (source.trim() === '') { teardown(block); return; }
    let entry = entries.get(block);
    if (entry === undefined) {
      const host = document.createElement('div');
      host.dataset.mmHost = '';
      block.after(host);
      block.dataset.mmHidden = '';
      entry = { id: ++serial, host, root: createRoot(host), source: '', settled: false, timer: 0 };
      entries.set(block, entry);
    } else if (entry.host.previousElementSibling !== block) {
      block.after(entry.host);
    }
    if (entry.source !== source) {
      entry.source = source;
      entry.settled = false;
    }
    // A fence that is still the last block of its container may be paged or streamed
    // into; wait for quiet before drawing it.
    if (!isTrailing(block)) entry.settled = true;
    window.clearTimeout(entry.timer);
    if (!entry.settled) entry.timer = window.setTimeout(() => { entry.settled = true; render(entry); }, SETTLE_MS);
    render(entry);
  };
  const prune = () => {
    for (const block of [...entries.keys()]) if (!block.isConnected) teardown(block);
  };
  const pending = new Set();
  let scheduled = false;
  const flush = () => {
    prune();
    const blocks = [...pending];
    pending.clear();
    for (const block of blocks) consider(block);
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; flush(); });
  };
  const collect = node => {
    if (!(node instanceof Element)) return;
    const inside = node.closest(selector);
    if (inside !== null) pending.add(inside);
    if (node.matches(selector)) pending.add(node);
    for (const block of node.querySelectorAll(selector)) pending.add(block);
  };
  const observer = new MutationObserver(records => {
    let dirty = false;
    for (const record of records) {
      if (record.type === 'characterData') {
        const block = record.target.parentElement?.closest(selector);
        if (block) { pending.add(block); dirty = true; }
        continue;
      }
      for (const node of record.addedNodes) { collect(node); dirty = true; }
      if (record.removedNodes.length > 0) dirty = true;
      collect(record.target);
    }
    if (dirty || pending.size > 0) schedule();
  });
  for (const block of document.querySelectorAll(scope === null ? selector : `${scope} ${selector}`)) pending.add(block);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  flush();
  const offTheme = ctx.on('theme/change', () => {
    const next = currentPalette(ctx);
    if (next.revision === palette.revision) return;
    palette = next;
    for (const entry of entries.values()) render(entry);
  });
  const offLocale = ctx.on('locale/change', () => {
    for (const entry of entries.values()) render(entry);
  });
  return () => {
    offTheme();
    offLocale();
    observer.disconnect();
    for (const block of [...entries.keys()]) teardown(block);
    style.remove();
  };
}
export const inject = ['locale', 'theme'];
export function apply(ctx, config) {
  for (const [locale, dict] of Object.entries(dictionaries)) ctx.effect(() => ctx.locale.register(NS, locale, dict));
  // Read-only, page-local diagnostics allow verification on Desktop without CDP.
  const inspect = ctx.get('cordisInspect');
  if (inspect) ctx.effect(() => inspect.register({
    manifest: { id: 'MarkdownMermaid', description: 'Current Markdown Mermaid enhancement diagnostics.', methods: [{ name: 'status', description: 'Read enhanced diagram outcomes; never triggers rendering or reads files.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { description: 'Plugin version and enhanced diagram outcomes.' } }] },
    query: async method => {
      if (method !== 'status') throw new Error('Unknown diagnostics method');
      return { version: VERSION, diagrams: [...diagnostics.values()], zoomPreviews: [...zoomDiagnostics.values()].map(read => read()) };
    },
  }));
  ctx.effect(() => startEnhancer(ctx, config));
}

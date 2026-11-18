import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: ['src/client.jsx'], outfile: 'client.js', bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'react-dom/*'],
  define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: "window.__ModuleLoader__.load({id:'@local/markdown-mermaid',factory(require){const module={exports:{}};const exports=module.exports;" },
  footer: { js: 'return module.exports;}});' },
});

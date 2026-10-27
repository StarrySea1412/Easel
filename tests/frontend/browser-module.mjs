import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const require = createRequire(new URL('../../web/frontend/package.json', import.meta.url));
const ts = require('typescript');
const { Window } = await import(pathToFileURL(require.resolve('happy-dom')).href);
const compiled = new Map();

// Load actual source dependencies in one isolated browser context. Tests can
// replace an exported API after loading it; no real network request is allowed.
export function browserModules(overrides = {}) {
  const window = new Window({ url: 'https://easel.test/' });
  const globals = {
    console, window, document: window.document,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    Date, Math, Error, URL, URLSearchParams, crypto,
    AbortController, AbortSignal, TextDecoder, TextEncoder, Headers, Response,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch() { throw new Error('Unexpected network request in frontend test'); },
    ...overrides,
  };
  const modules = new Map();
  function load(path) {
    const filename = path instanceof URL ? fileURLToPath(path) : path;
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    if (filename.endsWith('.json')) {
      module.exports = JSON.parse(readFileSync(filename, 'utf8'));
      return module.exports;
    }
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText);
    const localRequire = specifier => {
      if (!specifier.startsWith('.')) return require(specifier);
      const base = resolve(dirname(filename), specifier);
      const target = ['', '.ts', '.tsx', '.json', '.js'].map(suffix => base + suffix).find(existsSync);
      if (!target) throw new Error(`Missing source module: ${specifier}`);
      return load(target);
    };
    runInNewContext(compiled.get(filename), { ...globals, module, exports: module.exports, require: localRequire }, { filename });
    return module.exports;
  }
  return { load, globals, window };
}

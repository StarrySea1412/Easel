import fs from 'node:fs';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const modules = new Map();

function relativeModule(specifier, parent) {
  for (const suffix of ['', '.ts', '.tsx', '.js', '.jsx']) {
    const candidate = new URL(specifier + suffix, parent);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Cannot resolve ${specifier} from ${parent}`);
}

export async function tsModuleUrl(url) {
  const href = String(url);
  if (modules.has(href)) return modules.get(href);
  let code = ts.transpileModule(fs.readFileSync(new URL(href), 'utf8'), {
    fileName: fileURLToPath(href),
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;

  const source = ts.createSourceFile(href, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const replacements = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    if (specifier.text.endsWith('.css')) {
      // Simulated DOM tests exercise component behavior, not CSS or layout.
      replacements.push({ start: statement.getStart(source), end: statement.end, text: '' });
      continue;
    }
    const target = specifier.text.startsWith('.')
      ? await tsModuleUrl(relativeModule(specifier.text, href))
      : import.meta.resolve(specifier.text);
    replacements.push({ start: specifier.getStart(source), end: specifier.end, text: JSON.stringify(target) });
  }
  for (const replacement of replacements.reverse()) {
    code = code.slice(0, replacement.start) + replacement.text + code.slice(replacement.end);
  }
  const result = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  modules.set(href, result);
  return result;
}

export async function loadTsModule(path, base = import.meta.url) {
  return import(await tsModuleUrl(new URL(path, base)));
}

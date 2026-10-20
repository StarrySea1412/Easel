import { readFile, readdir, writeFile } from 'node:fs/promises';
const roots = ['builtin', 'openclaw'].map(name => new URL(`../../../skills/${name}/`, import.meta.url));
const rules = JSON.parse(await readFile(new URL('../src/lib/skillDependencyRules.json', import.meta.url), 'utf8'));
const result = {};
const seen = new Set();
for (const root of roots) {
let names;
try { names = await readdir(root); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
for (const name of names.sort()) {
  if (seen.has(name)) continue;
  let body;
  try { body = await readFile(new URL(`${name}/SKILL.md`, root), 'utf8'); } catch { continue; }
  seen.add(name);
  const ids = rules.filter(rule => rule.markers.some(marker => body.includes(marker))).map(rule => rule.id);
  if (ids.length) result[name] = ids;
}
}
await writeFile(new URL('../src/lib/bundledSkillDependencies.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');

import { readFile, readdir, writeFile } from 'node:fs/promises';
const root = new URL('../../../skills/openclaw/', import.meta.url);
const rules = JSON.parse(await readFile(new URL('../src/lib/skillDependencyRules.json', import.meta.url), 'utf8'));
const result = {};
for (const name of (await readdir(root)).sort()) {
  let body;
  try { body = await readFile(new URL(`${name}/SKILL.md`, root), 'utf8'); } catch { continue; }
  const ids = rules.filter(rule => rule.markers.some(marker => body.includes(marker))).map(rule => rule.id);
  if (ids.length) result[name] = ids;
}
await writeFile(new URL('../src/lib/bundledSkillDependencies.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');

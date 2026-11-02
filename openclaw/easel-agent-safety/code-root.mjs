import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** OpenClaw captures plugins outside the application tree before loading them. */
export function resolveCodeRoot(moduleUrl, env = process.env) {
  const candidates = [env.EASEL_CODE_ROOT, env.EASEL_ROOT,
    path.resolve(path.dirname(fileURLToPath(moduleUrl)), '../..')];
  for (const value of candidates) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const root = path.resolve(value);
    if (existsSync(path.join(root, 'pyproject.toml'))
        && existsSync(path.join(root, 'easel/paths.py'))
        && existsSync(path.join(root, 'skills/shared/scripts/present_artifact.py'))) return realpathSync(root);
  }
  throw new Error('Easel 执行代码目录不可用，请检查运行环境');
}

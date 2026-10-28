import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const inside = (root, file) => { const rel = path.relative(root, file); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

/** Preserve the existing runtime guards; do not broaden media roots. */
export async function runtimeToolParams(event, ctx, config, env = process.env, platform = process.platform) {
  const args = event.params && typeof event.params === 'object' ? event.params : {};
  if (event.toolName === 'exec' && platform !== 'win32' && typeof args.command === 'string'
      && /^\s*set\s+-[^\n;]*\bpipefail(?:\s|;|$)/.test(args.command)) {
    return { params: { ...args, command: "bash -lc '" + args.command.replaceAll("'", "'\"'\"'") + "'" } };
  }
  if (event.toolName !== 'view_image') return;
  const value = config?.agents?.defaults?.imageModel;
  const model = typeof value === 'string' ? value : value?.primary;
  if (typeof model !== 'string' || !model.includes('/')) return { block: true, blockReason: '尚未配置图片理解模型；请配置支持图片的模型后继续，不能用像素统计猜测图像内容。' };
  const slash = model.indexOf('/');
  const configured = config?.models?.providers?.[model.slice(0, slash)]?.models?.find(row => row.id === model.slice(slash + 1));
  if (configured?.input && !configured.input.includes('image')) return { block: true, blockReason: '已配置的图片理解模型仅支持文本，请先选择视觉模型。' };
  const params = { ...args, model };
  const session = ctx?.sessionKey?.replace(/^agent:main:/, '');
  const state = env.EASEL_OPENCLAW_STATE_DIR || env.OPENCLAW_STATE_DIR;
  const data = env.EASEL_DATA_DIR;
  if (!state || !data || !session || !/^[A-Za-z0-9_.-]{1,200}$/.test(session)) return { params };
  const scope = createHash('sha256').update(session).digest('hex').slice(0, 20);
  const inbox = path.resolve(data, 'outputs', '_inbox');
  const own = path.join(inbox, scope);
  async function stage(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
    const target = path.resolve(value);
    if (!inside(inbox, target)) return value;
    const real = await fs.realpath(target);
    if (!inside(own, target) || !inside(own, real)) throw new Error('图片附件不属于当前会话');
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024 || !/\.(png|jpe?g|gif|webp)$/i.test(real)) throw new Error('图片附件格式或大小无效');
    const bytes = await fs.readFile(real);
    const folder = path.resolve(state, 'media', 'easel-attachments', scope);
    await fs.mkdir(folder, { recursive: true });
    if ((await fs.realpath(folder)) !== folder) throw new Error('图片暂存目录不安全');
    const staged = path.join(folder, createHash('sha256').update(bytes).digest('hex') + path.extname(real).toLowerCase());
    try { await fs.writeFile(staged, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; if ((await fs.lstat(staged)).isSymbolicLink() || !(await fs.readFile(staged)).equals(bytes)) throw new Error('图片暂存路径不安全'); }
    return staged;
  }
  try {
    if (params.path) params.path = await stage(params.path);
    if (Array.isArray(params.paths)) params.paths = await Promise.all(params.paths.map(stage));
  } catch { return { block: true, blockReason: '图片附件路径未通过当前会话安全校验，请重新上传；不要扩大目录权限。' }; }
  return { params };
}

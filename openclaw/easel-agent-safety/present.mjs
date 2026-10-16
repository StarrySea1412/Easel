import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** The runtime supplies session identity; model arguments cannot redirect delivery. */
export function registerPresent(api) {
  if (typeof api.registerTool !== 'function') return;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  api.registerTool(ctx => {
    const session = ctx.sessionKey?.replace(/^agent:main:/, '');
    if (!session || !/^[A-Za-z0-9_.-]{1,200}$/.test(session)) return null;
    return {
      name: 'easel_present', label: '交付文件到当前对话',
      description: '将已保存文件交付到当前Easel对话，支持图片和HTML预览。使用本轮Easel提供的ticket；不生成文件，不调用模型。',
      parameters: { type: 'object', additionalProperties: false, required: ['ticket', 'files'], properties: {
        ticket: { type: 'string', pattern: '^[a-f0-9]{48}$' },
        files: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string' } },
      } },
      async execute(call, args, signal) {
        if (!/^[a-f0-9]{48}$/.test(args.ticket) || !Array.isArray(args.files) || !args.files.length || args.files.length > 16
          || args.files.some(file => typeof file !== 'string' || file.length > 2048)) throw new Error('无效交付参数');
        const command = [path.join(root, 'skills/shared/scripts/present_artifact.py'), '--ticket', args.ticket, '--session', session, '--call', String(call)];
        for (const file of args.files) command.push('--file', file);
        return await new Promise((resolve, reject) => {
          const child = spawn(process.env.EASEL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), command,
            { cwd: root, windowsHide: true, signal, env: { ...process.env, PYTHONIOENCODING: 'utf-8', EASEL_CODE_ROOT: root } });
          let output = ''; let overflow = false;
          const timeout = setTimeout(() => child.kill(), 30000);
          child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 262144) { overflow = true; child.kill(); } });
          child.stderr.resume(); // stderr may include private paths; never expose raw process errors.
          child.on('error', () => { clearTimeout(timeout); reject(new Error('文件交付执行端不可用')); });
          child.on('close', code => {
            clearTimeout(timeout);
            if (code !== 0 || overflow) return reject(new Error('文件交付未通过校验，请核对本轮凭据与实际文件路径'));
            try {
              const result = JSON.parse(output); if (!result.ok) throw new Error();
              resolve({ content: [{ type: 'text', text: JSON.stringify(result) }], details: result });
            } catch { reject(new Error('文件交付没有返回有效回执')); }
          });
        });
      },
    };
  }, { name: 'easel_present' });
}

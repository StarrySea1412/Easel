import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function registerImage(api) {
  if (typeof api.registerTool !== 'function') return;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  api.registerTool(ctx => {
    const session = ctx.sessionKey?.replace(/^agent:main:/, '');
    if (!session || !/^[A-Za-z0-9_.-]{1,200}$/.test(session)) return null;
    return {
      name: 'easel_generate_image', label: '生成图片并交付到当前对话',
      description: '仅当用户明确要求生图时调用，可能产生图片费用。使用已配置专用图片模型，不回退聊天模型。固定requestId重复调用只取原任务；图片完成后自动展示在当前对话。排队时等待，不改requestId重试。Easel网页服务负责执行队列。',
      parameters: { type: 'object', additionalProperties: false, required: ['ticket', 'requestId', 'prompt'], properties: {
        ticket: { type: 'string', pattern: '^[a-f0-9]{48}$' },
        requestId: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,120}$' },
        prompt: { type: 'string', minLength: 1, maxLength: 2000 },
        size: { type: 'string', enum: ['auto','1024x1024','768x1024','1024x768','864x1536','1536x864','1024x1280','1280x1024','1024x1536','1536x1024'] },
      } },
      async execute(call, args, signal) {
        if (!args || !/^[a-f0-9]{48}$/.test(args.ticket) || !/^[A-Za-z0-9_.-]{1,120}$/.test(args.requestId)
          || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 2000) throw new Error('无效生图参数');
        const command = [path.join(root, 'skills/shared/scripts/image_job.py'), 'submit', '--ticket', args.ticket,
          '--session', session, '--request-id', args.requestId, '--prompt', args.prompt, '--size', args.size || '1024x1024'];
        return await new Promise((resolve, reject) => {
          const child = spawn(process.env.EASEL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), command,
            { cwd: root, windowsHide: true, signal, env: { ...process.env, PYTHONIOENCODING: 'utf-8', EASEL_CODE_ROOT: root } });
          let output = ''; let overflow = false;
          const timeout = setTimeout(() => child.kill(), 30000);
          child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 262144) { overflow = true; child.kill(); } });
          child.stderr.resume();
          child.on('error', () => { clearTimeout(timeout); reject(new Error('生图队列执行端不可用')); });
          child.on('close', code => {
            clearTimeout(timeout);
            if (code !== 0 || overflow) return reject(new Error('生图队列未接受任务，请核对本轮凭据和专用生图配置；不要更换请求标识重试'));
            try {
              const result = JSON.parse(output); if (!result.ok) throw new Error();
              resolve({ content: [{ type: 'text', text: JSON.stringify(result) }], details: result });
            } catch { reject(new Error('未取得任务回执，请先查看当前对话任务状态，勿重复提交')); }
          });
        });
      },
    };
  }, { name: 'easel_generate_image' });
}

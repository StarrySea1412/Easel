import { spawn } from 'node:child_process';
import { resolveCodeRoot } from './code-root.mjs';

export function registerArtifactWriter(api) {
  if (typeof api.registerTool !== 'function') return;
  const root = resolveCodeRoot(import.meta.url);
  api.registerTool(ctx => {
    const session = ctx.sessionKey?.replace(/^agent:main:/, '');
    if (!session || !/^[A-Za-z0-9_.-]{1,200}$/.test(session)) return null;
    return {
      name: 'easel_write_artifact', label: '分块保存文本产物',
      description: '长文本/HTML文件用此工具，避免超长工具参数。固定requestId，begin(filename)后按sequence从0有序append(text最多3000字符)，status查询断点，commit(expectedChunks)原子提交并返回真实路径，再easel_present交付。重复相同块安全，不覆盖已有成品。不生成AI图片。',
      parameters: { type: 'object', additionalProperties: false, required: ['operation', 'requestId'], properties: {
        operation: { type: 'string', enum: ['begin', 'append', 'status', 'commit'] },
        requestId: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,120}$' },
        filename: { type: 'string', maxLength: 128 },
        sequence: { type: 'integer', minimum: 0, maximum: 511 },
        text: { type: 'string', maxLength: 3000 },
        expectedChunks: { type: 'integer', minimum: 1, maximum: 512 },
      } },
      async execute(_call, args, signal) {
        return await new Promise((resolve, reject) => {
          const child = spawn(process.env.EASEL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
            ['-m', 'easel.artifact_writer', session], { cwd: root, windowsHide: true, signal,
              env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
          let output = '';
          const timeout = setTimeout(() => child.kill(), 15000);
          child.stdin.on('error', () => {});
          child.stdin.end(JSON.stringify(args));
          child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 16000) child.kill(); });
          child.stderr.resume();
          child.on('error', () => { clearTimeout(timeout); reject(new Error('文件写入执行端不可用，请查询原请求状态')); });
          child.on('close', code => {
            clearTimeout(timeout);
            try {
              const result = JSON.parse(output);
              if (code !== 0 || !result.ok) throw Error();
              resolve({ content: [{ type: 'text', text: JSON.stringify(result) }], details: result });
            } catch { reject(new Error('分块写入未通过校验；请查询原requestId的status核对断点，不要清空原产物')); }
          });
        });
      },
    };
  }, { name: 'easel_write_artifact' });
}

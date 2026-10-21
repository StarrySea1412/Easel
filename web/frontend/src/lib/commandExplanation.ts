/** Describe observable shell syntax, never infer the model's private intent. */
function segments(command: string): string[] {
  const result: string[] = [];
  let start = 0, quote = '', depth = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if ((c === '`' || c === '\\') && quote !== "'") { i++; continue; }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if ('({['.includes(c)) depth++;
    if (')}]'.includes(c)) depth = Math.max(0, depth - 1);
    if (!depth && (';\n|'.includes(c) || (c === '&' && command[i + 1] === '&'))) {
      result.push(command.slice(start, i).trim());
      if (command[i + 1] === c) i++;
      start = i + 1;
    }
  }
  result.push(command.slice(start).trim());
  return result.filter(Boolean);
}
function words(command: string): string[] {
  return (command.match(/"(?:[^"`\\]|[`\\].)*"|'(?:[^']|'')*'|[^\s]+/g) || [])
    .map(word => word.replace(/^(["'])([\s\S]*)\1$/, '$2'));
}
const file = (value = '') => value.split(/[\\/]/).pop() || value;
function describe(command: string, depth: number): string {
  const args = words(command.replace(/^&\s+/, ''));
  const executable = file(args[0]).toLowerCase().replace(/\.exe$/, '');
  const target = args.slice(1).find(word => !word.startsWith('-') && !/^[>|&]/.test(word));
  const suffix = target ? ` · ${file(target).slice(0, 100)}` : '';
  if (depth < 2 && /^(?:bash|sh|zsh|pwsh|powershell|cmd)$/.test(executable)) {
    const index = args.findIndex(word => /^(?:-[el]*c|-(?:command|c)|\/c)$/i.test(word));
    if (index >= 0 && args[index + 1]) return explainCommand(args.slice(index + 1).join(' '), depth + 1);
  }
  if (/^(?:cd|chdir|set-location|pushd)$/.test(executable)) return '切换工作目录';
  if (/^(?:pwd|get-location)$/.test(executable)) return '查看当前目录';
  if (/^(?:rg|grep|findstr|select-string)$/.test(executable)) return executable === 'rg' && args.includes('--files') ? '列出匹配文件 · rg --files' : `搜索文件内容 · ${executable}`;
  if (/^(?:ls|dir|get-childitem|find)$/.test(executable)) return `列出文件${suffix}`;
  if (/^(?:cat|type|get-content|head|tail|sed)$/.test(executable)) {
    if (/(?:^|\s)>>?\s*\S/.test(command)) return `运行文件处理命令 · ${executable}`;
    return `读取文件内容${/^(head|tail|sed)$/.test(executable) ? ` · ${executable}` : suffix}`;
  }
  if (/^(?:python[\d.]*|py)$/.test(executable)) {
    if (args.includes('-c')) return '运行 Python 内联代码';
    const index = args.indexOf('-m');
    if (index >= 0) return args[index + 1] === 'pytest' ? '运行测试 · pytest' : `运行 Python 模块 · ${args[index + 1] || '未记录'}`;
    return `运行 Python 脚本${suffix}`;
  }
  if (/^(?:npm|pnpm|yarn|bun)(?:\.cmd)?$/.test(executable)) {
    const action = args[1] === 'run' ? args[2] : args[1];
    const label = action && /^(?:test|build|lint|dev|install|ci)$/.test(action)
      ? ({test:'运行测试',build:'构建项目',lint:'检查代码',dev:'启动开发服务',install:'安装依赖',ci:'安装锁定依赖'} as Record<string,string>)[action] : '运行项目命令';
    return `${label} · ${executable}${action ? ' ' + action : ''}`;
  }
  if (executable === 'git') return `${({status:'查看代码状态',diff:'查看代码差异',log:'查看提交记录',show:'读取提交内容'} as Record<string,string>)[args[1]] || '执行 Git 命令'} · git ${args[1] || ''}`.trim();
  if (/^(?:curl|wget|invoke-webrequest|invoke-restmethod)$/.test(executable)) return `请求网络资源 · ${executable}`;
  if (/^(?:node|nodejs)$/.test(executable)) return args.some(word => /^-(?:e|p|eval|print)$/.test(word)) ? '运行 JavaScript 内联代码' : `运行 JavaScript 脚本${suffix}`;
  return `执行命令 · ${file(args[0] || '详情未记录').slice(0, 100)}`;
}
export function explainCommand(command: string, depth = 0): string {
  const parts = segments(command.slice(0, 16000));
  const directory = /^(?:cd|chdir|set-location|pushd)\s/i;
  const hasDirectory = parts.some(part => directory.test(part));
  const actions = parts.filter(part => !directory.test(part) && !/^(?:pwd|get-location)\s*$/i.test(part));
  const descriptions = [...new Set((actions.length ? actions : parts).map(part => describe(part, depth)))];
  return `${hasDirectory && actions.length ? '切换目录后，' : ''}${descriptions.slice(0, 3).join(' → ') || '执行命令 · 详情未记录'}${descriptions.length > 3 ? `（另 ${descriptions.length - 3} 项，展开查看）` : ''}`;
}

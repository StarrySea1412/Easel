import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTsModule} from './load-ts.mjs';
const {explainCommand} = await loadTsModule('../src/lib/commandExplanation.ts',import.meta.url);
const {operationTitle} = await loadTsModule('../src/lib/execution.ts',import.meta.url);

test('directory-prefixed commands expose actual actions, preserving quotes and nested code',()=>{
  assert.equal(explainCommand('cd /app && cat docs/readme.md'),'切换目录后，读取文件内容 · readme.md');
  assert.equal(explainCommand('cd /d "C:\\my project" && python skills/run.py'),'切换目录后，运行 Python 脚本 · run.py');
  assert.equal(explainCommand('Set-Location C:\\project; Get-Content -LiteralPath "a;b.md"'),'切换目录后，读取文件内容 · a;b.md');
  assert.equal(explainCommand('cd /app && rg "x; cat fake" docs'),'切换目录后，搜索文件内容 · rg');
  assert.equal(explainCommand('cd /app && python -c "print(1); print(2)"'),'切换目录后，运行 Python 内联代码');
  assert.equal(explainCommand('bash -lc "cd /app && rg --files"'),'切换目录后，列出匹配文件 · rg --files');
  assert.equal(explainCommand('cd /app && npm.cmd run build && npm.cmd test'),'切换目录后，构建项目 · npm.cmd build → 运行测试 · npm.cmd test');
  assert.equal(explainCommand('cd /app'),'切换工作目录');
  assert.equal(explainCommand('echo "cat foo && rg bar"'),'执行命令 · echo');
  assert.doesNotMatch(explainCommand('cat << EOF > file\nhello\nEOF'),/^读取文件内容/);
});
test('summary never replaces full command and process tools keep their meaning',()=>{
  const row={kind:'command',command:'cd /app && python -m pytest',path:'',name:'exec'};
  assert.equal(operationTitle(row),'切换目录后，运行测试 · pytest');
  assert.equal(row.command,'cd /app && python -m pytest');
  assert.equal(operationTitle({...row,name:'process'}),'读取进程状态');
  assert.equal(operationTitle({...row,kind:'tool',command:'',name:'easel_goal_update'}),'更新目标进度');
});

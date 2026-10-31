"""Version-audited local App Server transport. No shell, automatic replay or approvals."""
from __future__ import annotations

from collections import deque
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import uuid

AUDITED_VERSIONS = frozenset({'0.147.0'})


class CodexError(RuntimeError):
    pass


def command() -> list[str]:
    override = os.environ.get('EASEL_CODEX_BIN', '').strip()
    found = override or shutil.which('codex') or shutil.which('codex.cmd')
    if not found:
        raise CodexError('未安装 Codex CLI；请安装 @openai/codex@0.147.0 后重新检测。')
    path = Path(found).resolve()
    if path.suffix.lower() in ('.cmd', '.bat', '.ps1'):
        package = path.parent / 'node_modules' / '@openai' / 'codex'
        candidates = list(package.glob('node_modules/@openai/codex-win32-*/vendor/*/bin/codex.exe'))
        if candidates:
            return [str(candidates[0])]
        script = package / 'bin' / 'codex.js'
        node = shutil.which('node')
        if script.is_file() and node:
            return [node, str(script)]
        raise CodexError('Codex 启动脚本无法解析；EASEL_CODEX_BIN 可指定原生可执行文件。')
    if not path.is_file():
        raise CodexError('Codex 可执行文件不存在。')
    return [str(path)]


def runtime_info() -> dict:
    cmd = command()
    flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    try:
        result = subprocess.run(cmd + ['--version'], capture_output=True, text=True,
                                encoding='utf-8', timeout=10, **flags)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CodexError('Codex 版本检测失败。') from exc
    version = result.stdout.strip().removeprefix('codex-cli ')
    if result.returncode or version not in AUDITED_VERSIONS:
        raise CodexError(f'Codex 版本 {version[:80] or "未知"} 未完成本接入的协议验证；当前支持 0.147.0。')
    return {'version': version, 'command': cmd}


class CodexClient:
    """A reader thread always drains events while a user approval is pending."""
    def __init__(self, cwd: Path):
        info = runtime_info()
        self._setup(info['version'])
        flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        env = os.environ.copy()
        # Explicit optional home is scoped to this child; never changes the host environment.
        if env.get('EASEL_CODEX_HOME'):
            env['CODEX_HOME'] = str(Path(env['EASEL_CODEX_HOME']).expanduser().resolve())
        self.proc = subprocess.Popen(info['command'] + ['app-server', '--listen', 'stdio://'],
            cwd=str(cwd), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', bufsize=1, env=env, **flags)
        threading.Thread(target=self._read, daemon=True, name='easel-codex-rpc').start()
        threading.Thread(target=self._read_stderr, daemon=True, name='easel-codex-log').start()
        self._initialize()

    def _setup(self, version):
        self.version = version
        self._lock = threading.RLock()
        self._pending: dict[str, queue.Queue] = {}
        self._threads: dict[str, queue.Queue] = {}
        self._stderr = deque(maxlen=20)
        self._closed = threading.Event()

    def _initialize(self):
        try:
            from .version import application_version
            self.rpc('initialize', {'clientInfo': {'name': 'easel', 'title': 'Easel', 'version': application_version()},
                                   'capabilities': {'experimentalApi': True}}, timeout=30)
            self.send({'method': 'initialized', 'params': {}})
        except Exception:
            self.close()
            raise

    def send(self, payload: dict):
        with self._lock:
            if self._closed.is_set() or self.proc.poll() is not None:
                raise CodexError('Codex 连接已关闭；原任务不会自动重发。')
            try:
                self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + '\n')
                self.proc.stdin.flush()
            except (OSError, ValueError) as exc:
                raise CodexError('Codex 连接中断；任务状态需核实。') from exc

    def rpc(self, method: str, params: dict, timeout=30):
        ident = uuid.uuid4().hex
        response = queue.Queue(maxsize=1)
        with self._lock:
            self._pending[ident] = response
        try:
            self.send({'id': ident, 'method': method, 'params': params})
            try:
                message = response.get(timeout=timeout)
            except queue.Empty as exc:
                raise CodexError(f'{method} 等待回执超时；请求不会自动重发。') from exc
            if 'error' in message:
                error = message['error'] or {}
                raise CodexError(str(error.get('message', 'Codex 请求失败'))[:1000])
            return message.get('result') or {}
        finally:
            with self._lock:
                self._pending.pop(ident, None)

    def subscribe(self, thread_id: str) -> queue.Queue:
        with self._lock:
            if thread_id in self._threads:
                raise CodexError('此 Codex 会话已有活跃任务。')
            events = queue.Queue(maxsize=8192)
            self._threads[thread_id] = events
            return events

    def unsubscribe(self, thread_id: str):
        with self._lock:
            self._threads.pop(thread_id, None)

    def reply(self, ident, result: dict):
        self.send({'id': ident, 'result': result})

    def _read_stderr(self):
        for line in self.proc.stderr:
            self._stderr.append(line[:1000])

    def _read(self):
        try:
            for line in self.proc.stdout:
                if len(line) > 8_000_000:
                    raise CodexError('Codex 单条事件超过接收上限。')
                message = json.loads(line)
                self._dispatch(message)
        except (OSError, ValueError, queue.Full, CodexError):
            pass
        finally:
            self._transport_ended()

    def _dispatch(self, message):
        if not isinstance(message, dict):
            return
        if 'method' not in message:
            with self._lock:
                target = self._pending.get(str(message.get('id')))
            if target:
                target.put_nowait(message)
            return
        params = message.get('params') or {}
        with self._lock:
            target = self._threads.get(params.get('threadId'))
        if target is not None:
            target.put_nowait(message)
        elif 'id' in message:
            self.send({'id': message['id'], 'error': {'code': -32601,
                      'message': 'Easel has no active handler for this request'}})

    def _transport_ended(self):
        self._closed.set()
        failure = {'error': {'message': 'Codex 进程或事件连接已结束，任务未确认完成。'}}
        with self._lock:
            for target in self._pending.values():
                try:
                    target.put_nowait(failure)
                except queue.Full:
                    pass
            for target in self._threads.values():
                try:
                    target.put_nowait({'method': 'easel/transportClosed', 'params': {}})
                except queue.Full:
                    pass

    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        self._closed.set()

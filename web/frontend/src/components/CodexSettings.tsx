import { useEffect, useState } from 'react';
import { codexRequest, fetchCodexRuntime, type CodexRuntime } from '../lib/codex';
import '../styles/codex.css';

export default function CodexSettings() {
  const [runtime, setRuntime] = useState<CodexRuntime | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [authUrl, setAuthUrl] = useState('');
  const refresh = async (signal?: AbortSignal) => {
    setBusy(true); setError('');
    try { const value = await fetchCodexRuntime(signal); if (!signal?.aborted) setRuntime(value); }
    catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : '检测失败'); }
    finally { if (!signal?.aborted) setBusy(false); }
  };
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, []);
  const login = async () => {
    if (busy || !runtime?.available) return;
    setBusy(true); setError('');
    try {
      const result = await codexRequest<{authUrl?: string}>('login', {});
      const url = new URL(result.authUrl || '');
      if (url.protocol !== 'https:') throw new Error('登录地址无效。');
      setAuthUrl(url.href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法发起登录。'); }
    finally { setBusy(false); }
  };
  return <section className="codex-settings" aria-label="Codex">
    <h3>Codex</h3>
    <p>{runtime?.available ? `已检测到 ${runtime.version} · ${runtime.auth === 'login_required' ? '需要登录' : runtime.auth === 'local_provider' ? '使用服务供应商配置（尚未验证模型推理）' : '已读取服务账号'}` : busy ? '正在检测…' : runtime?.error || '尚未检测'}</p>
    {runtime?.available && <p>新建对话后可选择 Codex，使用运行服务的账号和配置。每轮展示服务返回的思考摘要。</p>}
    <div className="codex-actions"><button type="button" disabled={busy} onClick={() => void refresh()}>重新检测</button>
      <button type="button" disabled={busy || !runtime?.available} onClick={() => void login()}>登录 ChatGPT 账号</button>
      {authUrl && runtime?.available && <a href={authUrl} target="_blank" rel="noreferrer">打开登录页</a>}</div>
    {authUrl && runtime?.available && <p>登录完成后点击“重新检测”。</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

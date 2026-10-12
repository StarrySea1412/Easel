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
    setBusy(true); setError('');
    try {
      const result = await codexRequest<{authUrl?: string}>('login', {});
      const url = new URL(result.authUrl || '');
      if (url.protocol !== 'https:') throw new Error('登录地址无效。');
      setAuthUrl(url.href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法发起登录。'); }
    finally { setBusy(false); }
  };
  return <section className="codex-settings" aria-label="本机 Codex">
    <h3>本机 Codex</h3>
    <p>{runtime?.available ? `已检测到 ${runtime.version} · ${runtime.auth === 'login_required' ? '需要登录' : runtime.auth === 'local_provider' ? '使用本机供应商配置（尚未验证模型推理）' : '已读取本机账号'}` : busy ? '正在检测…' : runtime?.error || '尚未检测'}</p>
    <p>新建对话后可选择 Codex。使用本机账号和配置；每轮仅展示服务返回的思考摘要。Easel 技能和 Agent Office 的 Codex 适配待接通。</p>
    <div className="codex-actions"><button type="button" disabled={busy} onClick={() => void refresh()}>重新检测</button>
      <button type="button" disabled={busy || !runtime?.available} onClick={() => void login()}>登录 ChatGPT 账号</button>
      {authUrl && <a href={authUrl} target="_blank" rel="noreferrer">打开登录页</a>}</div>
    {authUrl && <p>登录完成后点击“重新检测”，此操作会登录本机 Codex。</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

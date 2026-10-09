import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchImageReverseConfig, saveImageReverseConfig, type ImageReverseProvider } from '../../lib/api';
import { fetchModelHealth, modelHealthLabel, probeModel, type ModelHealthSnapshot } from '../../lib/modelHealth';
import Select from '../ui/Select';
import { IconImage } from '../settingsIcons';
import './image-reverse-settings.css';

export default function ImageReverseSettings({ editor, revision, dirty = false }: { editor: ReactNode; revision: string; dirty?: boolean }) {
  const [providers, setProviders] = useState<ImageReverseProvider[]>([]);
  const [modelRef, setModelRef] = useState('');
  const [saved, setSaved] = useState('');
  const [health, setHealth] = useState<ModelHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [backendReady, setBackendReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    let alive = true; generation.current += 1; active.current?.abort(); setBusy(''); setLoading(true); setError('');
    const controller = new AbortController();
    Promise.allSettled([fetchImageReverseConfig(), fetchModelHealth(controller.signal)]).then(([config, state]) => {
      if (!alive) return;
      if (config.status === 'fulfilled') {
        setProviders(config.value.providers); setModelRef(config.value.modelRef || ''); setSaved(config.value.modelRef || '');
        const ready = typeof config.value.modelRef === 'string'; setBackendReady(ready);
        if (!ready) setError('后端尚未加载视觉反推配置更新，请重启工作台后再选择和保存模型。');
      } else setError(config.reason instanceof Error ? config.reason.message : '视觉模型配置读取失败');
      setHealth(state.status === 'fulfilled' ? state.value : null);
      setLoading(false);
    });
    return () => { alive = false; generation.current += 1; controller.abort(); active.current?.abort(); };
  }, [revision]);
  const selected = providers.find(row => row.configured && `${row.id}/${row.model}` === modelRef);
  const result = health?.results.find(row => row.modelRef === modelRef && row.mode === 'vision');
  async function run(action: 'save' | 'vision' | 'refresh') {
    if (active.current || loading || dirty || (action === 'save' && !backendReady) || (action === 'vision' && !selected)) return;
    const token = generation.current;
    const controller = new AbortController(); active.current = controller; setBusy(action); setError(''); setNotice('');
    try {
      if (action === 'save') {
        const value = await saveImageReverseConfig(modelRef);
        if (controller.signal.aborted || generation.current !== token) return;
        setSaved(value.modelRef); setNotice('视觉反推模型已保存。');
      } else {
        if (action === 'vision') await probeModel(modelRef, 'vision', '', controller.signal);
        const value = await fetchModelHealth(controller.signal);
        if (controller.signal.aborted || generation.current !== token) return;
        setHealth(value);
      }
    } catch (cause) { if (!controller.signal.aborted && generation.current === token) setError(cause instanceof Error ? cause.message : '操作失败，请重试'); }
    finally { if (active.current === controller) { active.current = null; if (!controller.signal.aborted) setBusy(''); } }
  }
  return <section className="reverse-settings" aria-labelledby="reverse-settings-title">
    <div className="reverse-settings-heading"><IconImage size={19} /><div><h3 id="reverse-settings-title">视觉反推模型</h3><p>识别参考图并生成提示词，需要支持图片输入的模型。</p></div></div>
    <label htmlFor="reverse-settings-model">图片理解模型</label>
    <Select id="reverse-settings-model" value={modelRef} disabled={loading || Boolean(busy) || dirty} options={[
      { value: '', label: '仅提取图片内嵌提示词', description: '本机读取，不调用视觉模型' },
      ...providers.map(row => ({ value: `${row.id}/${row.model}`, label: `${row.name} · ${row.model || '模型未填写'}`, disabled: !row.configured })),
      ...(modelRef && !providers.some(row => `${row.id}/${row.model}` === modelRef) ? [{ value: modelRef, label: `${modelRef} · 配置已改变`, disabled: true }] : []),
    ]} onChange={value => { setModelRef(value); setNotice(''); }} />
    <div className="reverse-settings-actions">
      <button type="button" className="btn btn-sm btn-primary" disabled={!backendReady || loading || Boolean(busy) || dirty || modelRef === saved || Boolean(modelRef && !selected)} onClick={() => void run('save')}>{busy === 'save' ? '保存中…' : '保存反推模型'}</button>
      <button type="button" className="btn btn-sm" disabled={loading || Boolean(busy) || dirty || !selected} onClick={() => void run('vision')}>{busy === 'vision' ? '视觉测试中…' : '视觉测试'}</button>
      <button type="button" className="link-btn" disabled={loading || Boolean(busy) || dirty} onClick={() => void run('refresh')}>刷新测试结果</button>
    </div>
    <p className="reverse-test-status" role="status">{loading ? '读取配置中…' : dirty ? '供应商有未保存修改，请先保存，再选择和测试模型。' : `视觉测试：${modelHealthLabel(result)}`}{result?.testedAt && <time> · {new Date(result.testedAt * 1000).toLocaleString('zh-CN')}</time>}</p>
    {result?.detail && <p className="foot-note">{result.detail}</p>}
    <p className="foot-note">测试将随机四格色块图片发送到所选模型，按颜色及位置判分；供应商可能计费。通过只代表本次识图成功。共用每 60 秒最多 2 次测试的限额。</p>
    <details className="model-settings-details"><summary>编辑视觉模型供应商、地址与 Key</summary>{editor}<p className="foot-note">复用已保存的图片理解供应商凭据；与对话配置共享。反推选择独立保存，不改变默认对话模型。</p></details>
    {notice && <p role="status">{notice}</p>}{error && <p className="env-error" role="alert">{error}</p>}
  </section>;
}

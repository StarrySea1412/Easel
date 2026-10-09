import { useEffect, useId, useRef, useState } from 'react';
import Select from '../ui/Select';
import { fetchOfficeTaskModels, type OfficeModelOption } from '../../lib/officeControls';
import { fetchModelHealth, modelHealthLabel, probeModel, saveModelHealthSchedules, type ModelHealthSchedule, type ModelHealthSnapshot, type ModelProbeMode } from '../../lib/modelHealth';
import './model-health.css';

const DEFAULT_PROMPT = '请只回复：连接成功';
export default function ModelHealthPanel({ targetModelRef, dirty = false }: { targetModelRef?: string; dirty?: boolean } = {}) {
  const prefix = useId();
  const [options, setOptions] = useState<OfficeModelOption[]>([]);
  const [snapshot, setSnapshot] = useState<ModelHealthSnapshot | null>(null);
  const [modelRef, setModelRef] = useState(targetModelRef || '');
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [enabled, setEnabled] = useState(false);
  const [intervalSeconds, setIntervalSeconds] = useState(900);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    Promise.allSettled([fetchOfficeTaskModels(null, controller.signal), fetchModelHealth(controller.signal)]).then(results => {
      if (controller.signal.aborted) return;
      const [models, health] = results;
      if (models.status === 'fulfilled') setOptions(models.value.options.filter(option => option.configured));
      setSnapshot(health.status === 'fulfilled' ? health.value : null);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') setError(failed.reason instanceof Error ? failed.reason.message : '模型状态暂不可读取。');
      setLoading(false);
    });
    return () => { controller.abort(); active.current?.abort(); };
  }, [revision]);
  const selected = options.find(option => option.id === modelRef);
  useEffect(() => {
    if (!targetModelRef) return;
    setModelRef(targetModelRef);
    const schedule = snapshot?.schedules.find(item => item.modelRef === targetModelRef);
    setPrompt(schedule?.prompt || DEFAULT_PROMPT); setEnabled(schedule?.enabled === true); setIntervalSeconds(schedule?.intervalSeconds || 900);
  }, [targetModelRef, snapshot?.schedules]);
  const choose = (value: string) => {
    setModelRef(value); const schedule = snapshot?.schedules.find(item => item.modelRef === value);
    setPrompt(schedule?.prompt || DEFAULT_PROMPT); setEnabled(schedule?.enabled === true); setIntervalSeconds(schedule?.intervalSeconds || 900); setNotice('');
  };
  const run = async (kind: ModelProbeMode | 'schedule') => {
    if (dirty || !selected || busy || loading || !prompt.trim() || (kind === 'schedule' && !snapshot)) return;
    const controller = new AbortController(); active.current = controller; setBusy(kind); setError(''); setNotice('');
    try {
      if (kind === 'schedule') {
        const schedule: ModelHealthSchedule = { modelRef, enabled, intervalSeconds, prompt: prompt.trim() };
        const latest = await fetchModelHealth(controller.signal);
        const schedules = [...latest.schedules.filter(item => item.modelRef !== modelRef), schedule];
        await saveModelHealthSchedules(schedules, controller.signal);
      } else await probeModel(modelRef, kind, prompt.trim(), controller.signal);
      const result = await fetchModelHealth(controller.signal);
      if (controller.signal.aborted) return; setSnapshot(result);
      setNotice(kind === 'schedule' ? '自动测活设置已保存。' : '测活请求已提交，结果以最新状态为准。');
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '模型测活未完成。'); }
    finally { if (active.current === controller) { active.current = null; if (!controller.signal.aborted) setBusy(''); } }
  };
  return <section className={`model-health-panel${targetModelRef ? ' model-health-inline' : ''}`} aria-labelledby={`${prefix}-title`}>
    <div className="model-health-heading"><div><h3 id={`${prefix}-title`}>模型测活</h3><p>读取状态不会调用模型。配置登记与实际文本、识图测试分别显示。</p></div>
      <button type="button" className="btn btn-sm" disabled={loading || Boolean(busy)} onClick={() => setRevision(value => value + 1)}>刷新状态</button></div>
    {loading && <p role="status">正在读取模型状态…</p>}
    {dirty && <p role="status">配置有未保存修改；请先保存，再测试此模型。</p>}
    <fieldset disabled={dirty} className="model-health-controls">
    <div className="model-health-list">{options.filter(option => !targetModelRef || option.id === targetModelRef).map(option => <div className="model-health-row" key={option.id}><strong>{option.id}</strong>
      {(['text', 'vision'] as const).map(mode => { const result = snapshot?.results.find(item => item.modelRef === option.id && item.mode === mode); return <span key={mode} title={result?.detail}>{mode === 'text' ? '文本' : '图片'}：{modelHealthLabel(result)}{result?.testedAt && <small> {new Date(result.testedAt * 1000).toLocaleTimeString('zh-CN')}</small>}</span>; })}</div>)}</div>
    {!loading && !options.length && <p>尚无已配置模型。先保存模型渠道，再刷新状态。</p>}
    <div className="model-health-fields">{!targetModelRef && <><label htmlFor={`${prefix}-model`}>测试模型</label>
      <Select id={`${prefix}-model`} value={modelRef} disabled={loading || Boolean(busy)} options={[{ value: '', label: '选择已配置模型' }, ...options.map(option => ({ value: option.id, label: option.id }))]} onChange={choose} /></>}
      <label htmlFor={`${prefix}-prompt`}>文本测试提示词</label><textarea id={`${prefix}-prompt`} value={prompt} disabled={Boolean(busy)} maxLength={1000} rows={2} onChange={event => setPrompt(event.target.value)} />
    </div>
    <div className="model-health-actions"><button type="button" className="btn btn-sm" disabled={!selected || loading || Boolean(busy) || !prompt.trim()} onClick={() => void run('text')}>{busy === 'text' ? '文本测活中…' : '测试文本'}</button>
      <button type="button" className="btn btn-sm" disabled={!selected || loading || Boolean(busy) || !prompt.trim()} onClick={() => void run('vision')}>{busy === 'vision' ? '图片测活中…' : '测试图片识别'}</button></div>
    <p className="foot-note">图片使用后台生成的四格测试图，检验颜色、位置和排列顺序；成功只证明这次测试通过，不保证所有图片任务或未来调用。手动测试会产生供应商请求。</p>
    <div className="model-health-schedule"><label><input type="checkbox" checked={enabled} disabled={!selected || Boolean(busy)} onChange={event => setEnabled(event.target.checked)} /> 为所选模型启用自动文本测活</label>
      <Select aria-label="自动测活间隔" value={String(intervalSeconds)} disabled={!selected || Boolean(busy)} options={[{ value: '900', label: '每 15 分钟' }, { value: '1800', label: '每 30 分钟' }, { value: '3600', label: '每小时' }]} onChange={value => setIntervalSeconds(Number(value))} />
      <button type="button" className="btn btn-sm" disabled={!selected || !snapshot || loading || Boolean(busy) || !prompt.trim()} onClick={() => void run('schedule')}>{busy === 'schedule' ? '保存中…' : '保存自动测活'}</button></div>
    <p className="foot-note">默认关闭自动测活，启用后按所选间隔发送上述提示词。限额：每 {snapshot?.limit.windowSeconds || 60} 秒 {snapshot?.limit.requests || 2} 次，每渠道最多 {snapshot?.limit.automaticModelsPerProvider || 2} 个自动模型；超过 {Math.round((snapshot?.staleAfterSeconds || 900) / 60)} 分钟标记状态过期。</p>
    </fieldset>
    {notice && <p role="status">{notice}</p>}{error && <p className="model-health-error" role="alert">{error}</p>}
  </section>;
}

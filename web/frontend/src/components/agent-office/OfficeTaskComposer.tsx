import { useEffect, useId, useRef, useState } from 'react';
import type { ChatSession, StreamState } from '../../lib/store';
import { fetchOfficeTaskModels, type OfficeModelCapability } from '../../lib/officeControls';
import RadioGroup from '../ui/RadioGroup';
import ModelRoutePicker, { type ModelRouteSelection } from '../ui/ModelRoutePicker';
import './office-task-composer.css';

export interface OfficeTaskRequest { sessionId: string | null; message: string; modelRef?: string }
export interface OfficeTaskComposerProps {
  session: ChatSession | null;
  stream?: StreamState;
  stopping?: boolean;
  stopError?: string;
  onSubmit: (request: OfficeTaskRequest) => boolean;
  onStop?: (sessionId: string) => void;
  onOpenModels?: () => void;
  onOpenChat?: (sessionId: string) => void;
}

export default function OfficeTaskComposer(props: OfficeTaskComposerProps) {
  return <TaskForm key={props.session?.id || 'new-task'} {...props} />;
}

function TaskForm({ session, stream, stopping = false, stopError, onSubmit, onStop, onOpenModels, onOpenChat }: OfficeTaskComposerProps) {
  const prefix = useId();
  const canContinue = Boolean(session && !session.importedFromBackup);
  const [target, setTarget] = useState<'current' | 'new'>(canContinue ? 'current' : 'new');
  const [message, setMessage] = useState('');
  const [routeMode, setRouteMode] = useState<'default' | 'specific'>('default');
  const [selection, setSelection] = useState<ModelRouteSelection>({ provider: '', modelRef: '' });
  const [capability, setCapability] = useState<OfficeModelCapability | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const sending = useRef(false);
  const targetId = target === 'current' && canContinue ? session!.id : null;
  const recovering = Boolean(targetId && session?.pendingTurnId && session.messages.at(-1)?.role === 'user' && !stream);
  const busy = Boolean(targetId && (stream || stopping || recovering));
  const selected = capability?.options.find(option => option.id === selection.modelRef && option.provider === selection.provider && option.configured);
  const specificReady = !loading && capability?.available && Boolean(selected);
  const last = session?.messages.at(-1);
  const requestedModel = stream?.requestedModelRef || last?.requestedModelRef;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadError(''); setCapability(null);
    fetchOfficeTaskModels(targetId, controller.signal).then(value => {
      if (!controller.signal.aborted) setCapability(value);
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : '模型选项暂不可用。');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [targetId, revision]);

  useEffect(() => { if (!stream && !stopping) sending.current = false; }, [stream, stopping]);

  const submit = () => {
    if (!message.trim() || busy || sending.current || (routeMode === 'specific' && !specificReady)) return;
    sending.current = true;
    try {
      const accepted = onSubmit({ sessionId: targetId, message: message.trim(), ...(routeMode === 'specific' ? { modelRef: selection.modelRef } : {}) });
      if (accepted) { setMessage(''); setNotice('任务已提交，可在下方查看进展。'); }
      else { sending.current = false; setNotice('当前会话暂不能接收任务，输入已保留，请检查运行状态后重试。'); }
    } catch {
      sending.current = false; setNotice('任务提交未完成，输入已保留，请重试。');
    }
  };

  return <section className="office-task-composer" aria-labelledby={`${prefix}-heading`}>
    <div className="office-task-heading">
      <div><h2 id={`${prefix}-heading`}>交给办公室</h2><p>描述任务，跟进过程，随时中断。</p></div>
      <RadioGroup aria-label="任务会话" value={target} onChange={value => { setTarget(value); setNotice(''); }} options={[
        { value: 'current', label: '继续当前会话', disabled: !canContinue }, { value: 'new', label: '新建任务' },
      ]} />
    </div>
    <p className="office-task-context">{targetId ? `当前会话：${session?.title || '未命名会话'}` : '新建独立会话，任务开始后自动切换到其进展。'}</p>
    <form onSubmit={event => { event.preventDefault(); submit(); }}>
      <label className="office-task-label" htmlFor={`${prefix}-message`}>任务内容</label>
      <textarea id={`${prefix}-message`} rows={3} value={message} disabled={busy} maxLength={20000}
        placeholder="例如：研究本周热点，分工整理选题与素材，给出可检查的结果。"
        onChange={event => { setMessage(event.target.value); setNotice(''); }} />
      <div className="office-task-model-heading">
        <RadioGroup aria-label="本轮模型选择" value={routeMode} onChange={setRouteMode} disabled={busy} options={[
          { value: 'default', label: '使用会话配置' }, { value: 'specific', label: '指定渠道与模型' },
        ]} />
        {onOpenModels && <button type="button" className="office-control-link" onClick={onOpenModels}>管理模型渠道 ↗</button>}
      </div>
      {routeMode === 'specific' && <div className="office-task-routing">
        <ModelRoutePicker options={capability?.options || []} selection={selection} onChange={setSelection} disabled={busy || loading || !capability?.available} />
        <p className="office-control-note">仅用于本次提交。所选模型不可用时会明确报错；配置登记不代表凭据或实际调用已验证。</p>
        {loading && <p className="office-control-note" role="status">正在核验模型选择能力…</p>}
        {!loading && !capability?.available && <p className="office-control-note" role="status">{loadError || capability?.reason || '当前无法指定模型，请检查网关与模型配置。'}</p>}
        {!loading && capability?.available && selection.modelRef && !selected && <p className="office-control-error" role="alert">所选模型已不在当前可用配置中，请重新选择。原选择不会自动替换。</p>}
        <button type="button" className="office-control-link" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}>刷新模型选项</button>
      </div>}
      <div className="office-task-actions">
        <button type="submit" className="office-button office-button-primary" disabled={!message.trim() || busy || (routeMode === 'specific' && !specificReady)}>{targetId ? '发送到当前会话' : '开始任务'}</button>
        {session && onOpenChat && <button type="button" className="office-button" onClick={() => onOpenChat(session.id)}>打开对话</button>}
        {stream && session && onStop && <button type="button" className="office-button office-control-stop" disabled={stopping} onClick={() => onStop(session.id)}>{stopping ? '等待停止确认…' : '停止本轮任务'}</button>}
      </div>
    </form>
    {stream && <p className="office-task-status" role="status">{stream.activity || '任务已提交，等待后台返回进展。'}</p>}
    {requestedModel && <p className="office-control-note">{stream ? '本轮指定' : '最近一轮指定'}：{requestedModel}。实际执行模型以运行记录为准。</p>}
    {recovering && <p className="office-control-note" role="status">本会话有尚待恢复的任务，请打开对话接回结果后再继续。</p>}
    {stopping && <p className="office-control-note" role="status">正在请求停止；后台确认前会继续接收结果。</p>}
    {stopError && <p className="office-control-error" role="alert">{stopError}</p>}
    {last?.role === 'assistant' && last.error && !stream && <p className="office-control-error" role="alert">上一轮未完成：{last.error.message}</p>}
    {notice && <p className="office-control-note" role="status">{notice}</p>}
  </section>;
}

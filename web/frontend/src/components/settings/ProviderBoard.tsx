import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import ProviderIcon from '../ProviderIcon';
import type { ModelRow, ModelPreset, DiscoverResult } from '../../lib/api';
import { SettingsField } from './SettingsField';
import Select from '../ui/Select';
import { IconEdit, IconMic, IconMusic, IconPlay, IconText } from '../icons';
import ProviderActionsMenu from './ProviderActionsMenu';
import { IconFilm, IconGlobe, IconHexagon, IconImage, IconMonitor } from '../settingsIcons';

export type ProviderBoardOptions = {
      onRow?: (i: number, patch: Partial<ModelRow>) => void;
      onSave?: () => void;
      onSaveRow?: (i: number) => void;
      saveMessage?: (i: number) => string;
      isDirty?: (i: number) => boolean;
      saving?: boolean;
      onPrimary?: (i: number) => void;
      primarySaved?: (i: number) => boolean;
      primaryBusy?: boolean;
      onMove?: (from: number, to: number) => void;
      onRemove?: (i: number) => void;
      media?: boolean;
      channel?: string;                    // 用于「获取模型」的通道标识
      presets?: ModelPreset[];             // 服务商预设（公开端点）
      discovery?: (i: number) => DiscoverResult | 'loading' | undefined;
      onDiscover?: (i: number) => void;
      onPickPreset?: (i: number, p: ModelPreset) => void;
      onOpenEnvironment?: () => void;
      health?: (i: number, open?: boolean) => ReactNode;
      onCheck?: (i: number) => void;
      checkBusy?: (i: number) => boolean;
      checkReason?: (i: number) => string | undefined;
      checkLabel?: (i: number) => string;
      checkFeedback?: (i: number) => ReactNode;
    };

const SLOT_EDIT: Record<string, { model: boolean; base: boolean }> = {
  openai: { model: true, base: true }, relay: { model: true, base: true },
  anthropic: { model: true, base: true }, siliconflow: { model: true, base: true },
  custom: { model: true, base: true },
};
const hhmm = (ts: number) => new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

type BoardProps = {
  ops?: ProviderBoardOptions;
  resultText: (row: ModelRow) => { text: string; cls: string };
};

const rowKey = (row: ModelRow) => row.providerId || row.draftId || `${row.slot || row.type}:${row.name}`;

function ProviderCard({ r, i, count, ops, resultText, dragging, onGrab }: BoardProps & {
  r: ModelRow; i: number; count: number; dragging?: boolean;
  onGrab?: (pointerId: number) => void;
}) {
          const rt = resultText(r);
          const ed = SLOT_EDIT[r.slot || '']
            || (ops?.media && r.slot
              ? { model: r.modelEditable !== false, base: r.baseEditable !== false }
              : undefined);
          const isCustom = r.slot === 'custom';
          const discovery = ops?.discovery?.(i);
          const discovering = discovery === 'loading';
          const checking = ops?.onCheck ? ops.checkBusy?.(i) === true : discovering;
          const needsKey = !r.keyNew?.trim() && (!r.keyMasked || r.keyMasked === '—');
          const checkReason = ops?.onCheck ? ops.checkReason?.(i) : needsKey ? '先填写 API Key，再检测连接' : undefined;
          const subtitle = !r.slot && r.role === '免配';
          const local = r.type === 'local';
          const [expanded, setExpanded] = useState(false);
          const [manualModel, setManualModel] = useState(false);
          const choices = discovery && discovery !== 'loading' && discovery.ok ? discovery.models : [];
          const isChat = ops?.channel === 'chat';
          const dirty = ops?.isDirty?.(i) || false;
          const saveMessage = ops?.saveMessage?.(i);
          const panelId = useId();
          const reference = r.contextReference?.modelId === r.model ? r.contextReference : null;
          const protocol = r.protocol || r.type || 'openai';
          const cloud = ops?.channel === 'transcribe' && !subtitle && !local;
          const title = subtitle ? '自带字幕' : local ? '本地兜底' : cloud ? '云端转写' : r.name || '未命名供应商';
          const role = subtitle ? '优先读取 · 免配置' : local ? '云端不可用时接替' : cloud ? '需要 API Key'
            : r.role === '主' ? '默认通道' : r.role === '备' ? '备用通道' : r.role;
          const address = subtitle || local ? role : r.baseUrl?.trim() && r.baseUrl !== '—' ? r.baseUrl
            : ed ? ops?.media && r.baseOptional !== false ? '使用供应商预置地址' : '尚未填写地址'
              : role || r.sub;
          const Glyph = subtitle ? IconText : local ? IconMonitor : cloud || ops?.channel === 'speech' ? IconMic
            : ops?.channel === 'image' ? IconImage : ops?.channel === 'video' ? IconFilm
              : ops?.channel === 'music' ? IconMusic : r.slot === 'relay' ? IconGlobe : IconHexagon;
          return (
            <article data-provider-key={rowKey(r)} className={`provider-card${isChat && r.enabled === false ? ' is-disabled' : ''}${dragging ? ' is-dragging' : ''}`}>
              <div className="provider-compact-row">
              {ops?.onMove && <button type="button" className="provider-drag-handle" disabled={ops.saving}
                aria-label={`排序${title}，第${i + 1}项，共${count}项`} title="拖动排序；方向键上下移动，Home/End 移到首尾，保存后生效"
                onPointerDown={event => { if (event.button !== 0 || event.isPrimary === false) return; event.preventDefault(); event.currentTarget.focus(); onGrab?.(event.pointerId); }}
                onKeyDown={event => { const to = event.key === 'ArrowUp' ? i - 1 : event.key === 'ArrowDown' ? i + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null; if (to !== null) { event.preventDefault(); ops.onMove?.(i, to); } }}>
                <svg width="14" height="18" viewBox="0 0 14 18" fill="currentColor" aria-hidden="true">{[5,9].flatMap(x => [4,9,14].map(y => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2"/>))}</svg>
              </button>}
              <button type="button" className="provider-head provider-toggle" aria-expanded={expanded} aria-controls={panelId}
                aria-label={`${expanded ? '收起' : '展开'}${title}配置`} onClick={() => setExpanded(!expanded)}>
                <span className="provider-glyph" aria-hidden="true">{subtitle || local ? <Glyph size={19} /> : <ProviderIcon row={r} fallback={Glyph} />}</span>
                <span className="provider-heading">
                  <span className="provider-name-row"><strong>{title}</strong>{(ops?.primarySaved ? ops.primarySaved(i) : r.role === '主') && <span className="provider-default-badge">默认</span>}{dirty && <span className="provider-default-badge">待保存</span>}</span>
                  <small title={address}>{address}</small>
                  {isChat && <small className="provider-chat-summary">{r.enabled === false ? '已停用' : '已启用'} · {r.chatModels?.length ? r.chatModels.join('、') : '保存后出现在对话模型列表'}</small>}
                </span>
              </button>
              {ed && <div className="provider-quick-actions">
                {isChat && ops?.onPrimary && <button type="button" className="adv-btn provider-text-action provider-default-action" aria-label={`设${title}为默认模型`} disabled={!r.model || ops.saving || ops.primaryBusy || (ops.primarySaved?.(i) && !dirty)} title={`保存${title}当前模型并设为新对话默认`} onClick={() => ops.onPrimary?.(i)}>{ops.primarySaved?.(i) && !dirty ? '默认模型' : '设为默认'}</button>}
                {(ops?.onCheck || ops?.onDiscover) && <button type="button" className="adv-btn provider-text-action provider-connection-action" aria-label={`检测${title}${ops.onCheck ? '模型可用性' : '连接'}`} title={checkReason || `${ops?.checkLabel?.(i) || '直接测试'}：使用内置参数，供应商可能计费`} disabled={Boolean(checkReason) || checking || ops.saving} aria-busy={checking} onClick={() => ops.onCheck ? ops.onCheck(i) : ops.onDiscover?.(i)}>{checking ? <span className="spin"/> : <IconPlay size={14}/>}<span>{checking ? '测试中' : ops?.checkLabel?.(i) || '测试'}</span></button>}
                {ops?.onRow && <button type="button" className="adv-btn provider-icon-action" aria-label={`编辑${title}配置`} title="编辑配置" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(!expanded)}><IconEdit size={16}/></button>}
                {ops?.onRemove && <ProviderActionsMenu title={title} disabled={ops.saving} onDelete={() => ops.onRemove?.(i)}/>}
              </div>}
              </div>
              {ops?.checkFeedback?.(i)}
              {!expanded && discovery && <div className={`provider-check-result${discovery !== 'loading' && !discovery.ok ? ' bad' : ''}`} role="status" aria-live="polite">
                {discovery === 'loading' ? <span>正在检测连接…</span> : <>
                  <div><strong>{discovery.ok ? '连接检查通过' : '连接检查未通过'}</strong><span>{discovery.message}</span>
                    <small>本次读取模型列表 · {hhmm(discovery.fetchedAt)}；文本与图片测试可在编辑配置内使用。</small></div>
                  <button type="button" className="adv-btn" disabled={needsKey || ops?.saving} onClick={() => ops?.onDiscover?.(i)}>重新检测</button>
                </>}
              </div>}
              <div className="provider-body" id={panelId} hidden={!expanded}>
              {isChat && ops?.health?.(i)}
              {!ed && <div className="provider-fixed">
                <p>{subtitle ? '直接读取视频已有的字幕文件，无需填写模型、地址或密钥。没有自带字幕时会继续尝试云端转写。'
                  : local ? '在本机运行 faster-whisper，无需 API Key。请先安装本地组件；云端不可用时由它接替。'
                    : '此能力使用内建配置，当前卡片无需填写模型、地址或密钥。'}</p>
                {local && ops?.onOpenEnvironment && <button type="button" className="adv-btn" onClick={ops.onOpenEnvironment}>打开环境安装</button>}
              </div>}
              {ed && <div className="provider-fields">
              {isCustom && <SettingsField label="供应商标识">
                  <input
                    className="mock"
                    value={r.name}
                    placeholder="名称"
                    aria-label="供应商名称"
                    disabled={Boolean(r.providerId)}
                    onChange={(e) => ops?.onRow?.(i, { name: e.target.value.toLowerCase() })}
                  />
              </SettingsField>}
              {ops?.channel === 'chat' && <SettingsField label="请求协议">
                <Select aria-label="请求协议" value={protocol} disabled={r.protocolEditable === false}
                  options={[...(!['openai', 'anthropic'].includes(protocol) ? [{ value: protocol, label: `${protocol}（当前配置）`, disabled: true }] : []),
                    { value: 'openai', label: 'OpenAI Chat Completions', description: '/chat/completions' },
                    { value: 'anthropic', label: 'Anthropic Messages', description: '/v1/messages' }]}
                  onChange={(protocol) => ops?.onRow?.(i, { protocol, type: protocol })} />
                <span className="hint">{r.protocolNote || '按服务商接口选择；保存后用于后续请求，不会自动切换协议。'}</span>
              </SettingsField>}
              {(ops?.presets || []).length > 0 && <SettingsField label="服务商预设（可选）"><Select
                    value=""
                    aria-label="服务商预设"
                    placeholder="服务商预设…"
                    onChange={(value) => {
                      const p = (ops?.presets || []).find((x) => x.id === value);
                      if (p) ops?.onPickPreset?.(i, p);
                    }}
                    options={(ops?.presets || []).map((preset) => ({ value: preset.id,
                      label: preset.name, description: preset.note,
                      disabled: ops?.channel === 'chat' && r.protocolEditable === false && preset.protocol !== protocol,
                    }))}
                  /></SettingsField>}
              <SettingsField label="模型">
              {ed.model ? (
                <span className="key-stack">
                  <span className="model-fetch">
                    <span className="provider-model-input">
                    {choices.length > 0 && !manualModel && <Select aria-label="获取的可用模型" value={r.model} placeholder="选择模型"
                      options={[...(!choices.includes(r.model) && r.model ? [{ value: r.model, label: r.model, description: '当前填写的模型' }] : []), ...choices.map(model => ({ value: model, label: model }))]}
                      onChange={model => ops?.onRow?.(i, { model })}/>}
                    <input
                      className="mock"
                      hidden={choices.length > 0 && !manualModel}
                      aria-label="模型名称"
                      value={r.model}
                      placeholder={ops?.media ? '留空使用提供商预置模型' : isCustom ? '模型名' : ''}
                      onChange={(e) => ops?.onRow?.(i, { model: e.target.value })}
                    />
                    </span>
                    {ops?.onDiscover && <button
                      className="adv-btn"
                      title={needsKey ? '先填写 API Key，或导入已有配置' : '用此地址和已保存 / 刚填的 Key 读取模型列表，不发起模型推理'}
                      disabled={needsKey || discovering}
                      onClick={() => { setManualModel(false); ops?.onDiscover?.(i); }}
                    >
                      {discovering ? '读取中…' : '获取模型列表'}
                    </button>}
                  </span>
                  {choices.length > 0 && <span className="provider-model-meta"><span>已获取 {choices.length} 个候选模型</span><button type="button" className="adv-btn" onClick={() => setManualModel(value => !value)}>{manualModel ? '从列表选择' : '手动输入'}</button></span>}
                  {discovery && <div className={`provider-discovery-note${discovery !== 'loading' && !discovery.ok ? ' bad' : ''}`} role="status">{discovery === 'loading' ? '正在获取模型列表…' : <>
                    <span>{discovery.message}</span>
                    {!discovery.ok && <small>请核对地址、协议和 Key；获取失败也可手动输入模型并保存。</small>}
                    {discovery.ok && !choices.length && <small>接口没有返回模型列表，请手动填写模型后保存。</small>}
                    {discovery.ok && <small>{hhmm(discovery.fetchedAt)} · {discovery.keySource === 'input' ? '使用刚填的 Key' : '使用已保存的 Key'} · 只读取候选列表，尚未进行模型推理</small>}
                  </>}</div>}
                  {ops?.onDiscover && needsKey && <span className="hint">先填写 API Key，或从配置导入；填写后可读取模型列表。</span>}
                </span>
              ) : (
                <><span className="cell-text" title={r.model || '提供商预置模型'}>{r.model || '提供商预置模型'}</span>
                  <span className="hint">当前通道使用预置模型，此配置入口不支持覆盖。需要其他模型时，可切换到支持自定义模型的提供商。</span></>
              )}
              </SettingsField>
              {ops?.channel === 'chat' && <SettingsField label="上下文窗口（Token）">
                <input className="mock" type="number" aria-label="上下文窗口（Token）" min="1024" max="10000000" step="1"
                  value={r.contextWindow ?? ''} placeholder={reference ? `原厂参考 ${reference.label}，尚未写入配置` : '未配置；运行器可能使用通用默认值'}
                  onChange={event => ops?.onRow?.(i, { contextWindow: event.target.value === '' ? null : Number(event.target.value) })} />
                <span className="hint">按此渠道模型的实际能力填写；保存后用于后续请求的上下文预算。这里不会增加模型本身的容量。</span>
                {reference && <span className="hint">原厂参考：{reference.label}（{reference.tokens.toLocaleString('zh-CN')} Token） · <a href={reference.url} target="_blank" rel="noopener noreferrer">{reference.source} ↗</a>。{reference.note}
                  {r.contextWindow == null && <button type="button" className="adv-btn" onClick={() => ops?.onRow?.(i, { contextWindow: reference.tokens })}>填入参考值，保存后生效</button>}
                </span>}
              </SettingsField>}
              <SettingsField label="Base URL">
              {ed.base ? (
                <input className="mock" aria-label="Base URL" value={r.baseUrl} placeholder={ops?.media && r.baseOptional !== false ? '留空使用提供商预置地址' : 'https://…'} onChange={(e) => ops?.onRow?.(i, { baseUrl: e.target.value })} />
              ) : (
                <><span className="cell-text" title={r.baseUrl || '提供商预置地址'}>{r.baseUrl || '提供商预置地址'}</span>
                  <span className="hint">当前通道使用预置服务地址，此配置入口不支持覆盖。需要其他地址时，可选择支持自定义地址的提供商。</span></>
              )}
              </SettingsField>
              <SettingsField label="API Key">
              {ed ? (
                r.key2Label ? (
                  <span className="key-stack">
                    <input
                      className="mock key-input"
                      type="password"
                      aria-label="API Key" value={r.keyNew || ''}
                      placeholder={needsKey ? '输入 API Key' : '已保存；留空保留原值'}
                      onChange={(e) => ops?.onRow?.(i, { keyNew: e.target.value })}
                    />
                    <input
                      className="mock key-input"
                      type="password"
                      aria-label={r.key2Label} value={r.keyNew2 || ''}
                      placeholder={r.key2Masked && r.key2Masked !== '—' ? '已保存；留空保留原值' : r.key2Label}
                      onChange={(e) => ops?.onRow?.(i, { keyNew2: e.target.value })}
                    />
                  </span>
                ) : (
                  <input
                    className="mock key-input"
                    type="password"
                    aria-label="API Key" value={r.keyNew || ''}
                    placeholder={needsKey ? '输入 API Key' : '已保存；留空保留原值'}
                    onChange={(e) => ops?.onRow?.(i, { keyNew: e.target.value })}
                  />
                )
              ) : (
                <span className="cell-text key-mask" title="密钥不显示明文">{r.keyMasked?.replace(/^[«《]|[»》]$/g, '') || '—'}</span>
              )}
              </SettingsField>
              </div>}
              <div className="provider-status">
              {isChat && <div className="provider-enable-control"><button type="button" role="switch" aria-label={`启用${title}`} aria-checked={r.enabled !== false} disabled={r.role === '主'} title={r.role === '主' ? '停用前请先设其他默认渠道' : '保存后生效；停用不删除模型和密钥'} onClick={() => ops?.onRow?.(i, { enabled: r.enabled === false })}><span aria-hidden="true"/></button><span>{r.enabled === false ? '已停用' : '已启用'}</span>{r.role === '主' && <small>默认渠道</small>}</div>}
              {!isChat && r.slot && ops?.onPrimary ? (
                <button
                  className={`tag ${r.role === '主' ? 'main' : 'backup'}`}
                  onClick={() => ops.onPrimary?.(i)}
                  title="设为主通道"
                >
                  {r.role === '主' ? '默认通道' : '设为默认通道'}
                </button>
              ) : !isChat ? (
                <span className={`tag ${r.role === '主' ? 'main' : 'backup'}`}>{role}</span>
              ) : null}
              <span className={`stt ${rt.cls}`}>{rt.text}</span>
              </div>
              {isChat && <div className="provider-chat-catalog" aria-label="对话模型"><strong>对话模型{r.enabled === false ? ' · 已停用，启用后可使用' : ''}</strong><div>{r.chatModels?.length ? r.chatModels.map(model => <span className="provider-model-chip" key={model}>{model}</span>) : <small>保存配置后自动出现在对话模型列表。</small>}</div>{r.model && !r.chatModels?.includes(r.model) && <small>保存后加入：{r.model}</small>}</div>}
              {ed && <div className="provider-save-actions"><button type="button" className="btn btn-sm btn-primary" disabled={ops?.saving} onClick={() => ops?.onSaveRow ? ops.onSaveRow(i) : ops?.onSave?.()}>{ops?.saving ? '保存中…' : '保存配置'}</button>
                {ops?.onCheck && <button type="button" className="btn btn-sm" disabled={Boolean(checkReason) || checking || ops.saving} title={checkReason || '实际模型请求可能计费'} onClick={() => ops.onCheck?.(i)}>{checking ? '测试中…' : ops.checkLabel?.(i) || '测试'}</button>}
                <small>{checkReason || '保存无需检测通过；密钥留空保留原值。'}</small></div>}
              {saveMessage && <p className="provider-save-message" role={saveMessage.startsWith('保存失败') ? 'alert' : 'status'}>{saveMessage}</p>}
              {!isChat && ops?.health?.(i)}
              </div>
            </article>
          );
}

export function ProviderBoard({ rows, ops, modelLoading, resultText }: BoardProps & { rows: ModelRow[]; modelLoading: boolean }) {
  const list = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const dragKey = useRef<string | null>(null);
  const dragPointer = useRef<number | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    list.current?.querySelectorAll<HTMLElement>('[data-provider-key]').forEach(card => {
      const key = card.dataset.providerKey!, top = card.offsetTop, previous = positions.current.get(key);
      next.set(key, top);
      if (!reduced && previous !== undefined && previous !== top && card.animate) {
        card.getAnimations?.().forEach(animation => animation.cancel());
        card.animate([{ transform: `translateY(${previous - top}px)` }, { transform: 'translateY(0)' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    });
    positions.current = next;
  }, [rows]);
  useEffect(() => {
    if (!dragging) return;
    const finish = () => { dragKey.current = null; dragPointer.current = null; setDragging(null); };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== dragPointer.current || !list.current || ops?.saving) return;
      event.preventDefault();
      const from = rows.findIndex(row => rowKey(row) === dragKey.current);
      if (from < 0) { finish(); return; }
      const top = list.current.getBoundingClientRect().top;
      // Layout offsets exclude the FLIP transform, so animated cards cannot bounce the target back.
      const cards = Array.from(list.current.querySelectorAll<HTMLElement>('[data-provider-key]'));
      let to = from;
      cards.forEach((card, index) => {
        const midpoint = top + card.offsetTop + card.offsetHeight / 2;
        if (index > from && event.clientY >= midpoint) to = index;
        if (index < from && event.clientY <= midpoint && to === from) to = index;
      });
      if (to !== from) ops?.onMove?.(from, to);
    };
    const up = (event: PointerEvent) => { if (event.pointerId === dragPointer.current) finish(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') finish(); };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', finish);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); window.removeEventListener('blur', finish); window.removeEventListener('keydown', key); };
  }, [dragging, rows, ops]);
  return (
    modelLoading && rows.length === 0 ? (
      <div className="board"><div className="empty"><span className="spin" /> 正在读取配置…<span className="hint">（后台繁忙时可能稍慢，会自动重试）</span></div></div>
    ) : rows.length === 0 ? (
      <div className="board"><div className="empty">还没有配置。<span className="hint">可在「环境安装」先补齐本地能力。</span></div></div>
    ) : (
      <div className="provider-list" ref={list}>
        {rows.map((r, i) => <ProviderCard key={rowKey(r)} r={r} i={i} count={rows.length} ops={ops} resultText={resultText}
          dragging={dragging === rowKey(r)} onGrab={pointerId => { dragKey.current = rowKey(r); dragPointer.current = pointerId; setDragging(rowKey(r)); }}/>) }
      </div>
    )
  );
}

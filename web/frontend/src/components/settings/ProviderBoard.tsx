import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import ProviderIcon from '../ProviderIcon';
import type { ModelRow, ModelPreset, DiscoverResult } from '../../lib/api';
import { SettingsField } from './SettingsField';
import Select from '../ui/Select';
import { IconChevron, IconMic, IconMusic, IconText } from '../icons';
import { IconFilm, IconGlobe, IconHexagon, IconImage, IconMonitor } from '../settingsIcons';

export type ProviderBoardOptions = {
      onRow?: (i: number, patch: Partial<ModelRow>) => void;
      onSave?: () => void;
      saving?: boolean;
      onPrimary?: (i: number) => void;
      onRemove?: (i: number) => void;
      media?: boolean;
      channel?: string;                    // 用于「获取模型」的通道标识
      presets?: ModelPreset[];             // 服务商预设（公开端点）
      discovery?: (i: number) => DiscoverResult | 'loading' | undefined;
      onDiscover?: (i: number) => void;
      onPickPreset?: (i: number, p: ModelPreset) => void;
      onOpenEnvironment?: () => void;
      health?: (i: number, open?: boolean) => ReactNode;
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

function ProviderCard({ r, i, ops, resultText }: BoardProps & { r: ModelRow; i: number }) {
          const rt = resultText(r);
          const ed = SLOT_EDIT[r.slot || '']
            || (ops?.media && r.slot
              ? { model: r.modelEditable !== false, base: r.baseEditable !== false }
              : undefined);
          const isCustom = r.slot === 'custom';
          const discovering = ops?.discovery?.(i) === 'loading';
          const needsKey = !r.keyNew?.trim() && (!r.keyMasked || r.keyMasked === '—');
          const subtitle = !r.slot && r.role === '免配';
          const local = r.type === 'local';
          const [expanded, setExpanded] = useState(false);
          const [quickEdit, setQuickEdit] = useState(false);
          const [quickHealth, setQuickHealth] = useState(false);
          const panelId = useId();
          const cloud = ops?.channel === 'transcribe' && !subtitle && !local;
          const title = subtitle ? '自带字幕' : local ? '本地兜底' : cloud ? '云端转写' : r.name || '未命名供应商';
          const role = subtitle ? '优先读取 · 免配置' : local ? '云端不可用时接替' : cloud ? '需要 API Key'
            : r.role === '主' ? '默认通道' : r.role === '备' ? '备用通道' : r.role;
          const Glyph = subtitle ? IconText : local ? IconMonitor : cloud || ops?.channel === 'speech' ? IconMic
            : ops?.channel === 'image' ? IconImage : ops?.channel === 'video' ? IconFilm
              : ops?.channel === 'music' ? IconMusic : r.slot === 'relay' ? IconGlobe : IconHexagon;
          return (
            <article className="provider-card">
              <div className="provider-compact-row">
              <button type="button" className="provider-head provider-toggle" aria-expanded={expanded} aria-controls={panelId}
                aria-label={`${expanded ? '收起' : '展开'}${title}配置`} onClick={() => setExpanded(!expanded)}>
                <span className="provider-glyph" aria-hidden="true">{subtitle || local ? <Glyph size={19} /> : <ProviderIcon row={r} fallback={Glyph} />}</span>
                <span className="provider-heading"><strong>{title}</strong>
                  <small title={r.model}>{ed ? r.model && r.model !== '—' ? r.model : '尚未选择模型' : r.sub}</small>
                </span>
                <span className="provider-summary-status"><span className={`stt ${rt.cls}`}>{rt.text}</span><small>{role}</small></span>
                <IconChevron size={15} className="provider-chevron" />
              </button>
              {ed && <div className="provider-quick-actions">
                {ed.model && ops?.onRow && <button type="button" className="adv-btn" aria-expanded={quickEdit} onClick={() => setQuickEdit(!quickEdit)}>改模型</button>}
                {ops?.health && <button type="button" className="adv-btn" aria-expanded={quickHealth} onClick={() => setQuickHealth(!quickHealth)}>检测</button>}
              </div>}
              </div>
              {quickEdit && ed?.model && <div className="provider-quick-edit">
                <label>模型<input className="mock" aria-label={`${title}快捷模型名称`} value={r.model === '—' ? '' : r.model} placeholder="模型名称" onChange={event => ops?.onRow?.(i, {model:event.target.value})} /></label>
                {ops?.onSave && <button type="button" className="btn btn-sm" disabled={ops.saving} onClick={ops.onSave}>{ops.saving ? '保存中…' : '保存修改'}</button>}
                <small>草稿；保存后生效</small>
              </div>}
              {quickHealth && ops?.health?.(i, true)}
              <div className="provider-body" id={panelId} hidden={!expanded}>
              {!ed && <div className="provider-fixed">
                <p>{subtitle ? '直接读取视频已有的字幕文件，无需填写模型、地址或密钥。没有自带字幕时会继续尝试云端转写。'
                  : local ? '在本机运行 faster-whisper，无需 API Key。请先安装本地组件；云端不可用时由它接替。'
                    : '此能力使用内建配置，当前卡片无需填写模型、地址或密钥。'}</p>
                {local && ops?.onOpenEnvironment && <button type="button" className="adv-btn" onClick={ops.onOpenEnvironment}>打开环境安装</button>}
              </div>}
              {ed && <div className="provider-fields">
              {isCustom && <SettingsField label="供应商名称">
                  <input
                    className="mock"
                    value={r.name}
                    placeholder="名称"
                    aria-label="供应商名称"
                    onChange={(e) => ops?.onRow?.(i, { name: e.target.value.toLowerCase() })}
                  />
              </SettingsField>}
              {isCustom && ops?.channel === 'chat' && <SettingsField label="请求协议">
                <Select aria-label="请求协议" value={r.protocol || r.type || 'openai'}
                  options={[{ value: 'openai', label: 'OpenAI 兼容', description: 'Chat Completions' }, { value: 'anthropic', label: 'Anthropic 兼容', description: 'Messages' }]}
                  onChange={(protocol) => ops?.onRow?.(i, { protocol, type: protocol })} />
              </SettingsField>}
              <SettingsField label="模型">
              {ed.model ? (
                <span className="key-stack">
                  {(ops?.presets || []).length > 0 && <Select
                    value=""
                    aria-label="服务商预设"
                    placeholder="服务商预设…"
                    onChange={(value) => {
                      const p = (ops?.presets || []).find((x) => x.id === value);
                      if (p) ops?.onPickPreset?.(i, p);
                    }}
                    options={(ops?.presets || []).map((preset) => ({ value: preset.id,
                      label: preset.name, description: preset.note,
                      disabled: ops?.channel === 'chat' && r.slot !== 'custom'
                        && preset.protocol !== (r.slot === 'openai' ? 'openai' : 'anthropic'),
                    }))}
                  />}
                  <span className="model-fetch">
                    <input
                      className="mock"
                      aria-label="模型名称"
                      value={r.model}
                      placeholder={ops?.media ? '留空使用提供商预置模型' : isCustom ? '模型名' : ''}
                      onChange={(e) => ops?.onRow?.(i, { model: e.target.value })}
                    />
                    {ops?.onDiscover && <button
                      className="adv-btn"
                      title={needsKey ? '先填写 API Key，或导入已有配置' : '用此地址和已保存 / 刚填的 Key 读取模型列表，不发起模型推理'}
                      disabled={needsKey || discovering}
                      onClick={() => ops?.onDiscover?.(i)}
                    >
                      {discovering ? '读取中…' : '获取模型列表'}
                    </button>}
                  </span>
                  {ops?.onDiscover && needsKey && <span className="hint">先填写 API Key，或从配置导入；填写后可读取模型列表。</span>}
                </span>
              ) : (
                <><span className="cell-text" title={r.model || '提供商预置模型'}>{r.model || '提供商预置模型'}</span>
                  <span className="hint">当前通道使用预置模型，此配置入口不支持覆盖。需要其他模型时，可切换到支持自定义模型的提供商。</span></>
              )}
              </SettingsField>
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
              {r.slot && ops?.onPrimary ? (
                <button
                  className={`tag ${r.role === '主' ? 'main' : 'backup'}`}
                  onClick={() => ops.onPrimary?.(i)}
                  title="设为主通道"
                >
                  {r.role === '主' ? '默认通道' : '设为默认通道'}
                </button>
              ) : (
                <span className={`tag ${r.role === '主' ? 'main' : 'backup'}`}>{role}</span>
              )}
              <span className={`stt ${rt.cls}`}>{rt.text}</span>
              {isCustom && ops?.onRemove ? (
                <button className="row-del" onClick={() => ops.onRemove?.(i)} title="删除该供应商">✕</button>
              ) : (
                <span />
              )}
              </div>
              {ed && <p className="provider-save-hint hint">修改保留为草稿；点击页面“保存”后生效。读取模型列表失败时，可手动填写可编辑的模型名称。</p>}
              {!quickHealth && ops?.health?.(i)}
              {(() => {
                if (!ops?.discovery) return null;
                const d = ops.discovery(i);
                if (!d) return null;
                if (d === 'loading') {
                  return <div className="discover-row"><span className="spin" /> 正在向 {r.baseUrl || '该地址'} 查询可用模型…</div>;
                }
                return (
                  <div className={`discover-row${d.ok ? ' ok' : ' bad'}`}>
                    <span className="dr-txt">
                      {d.ok ? '✓' : '✗'} {d.message}
                      {d.ok && <span className="dr-src">· 来源 {d.source} · {hhmm(d.fetchedAt)}
                        {d.keySource === 'saved' ? ' · 用已保存的 Key' : d.keySource === 'input' ? ' · 用刚填的 Key' : ' · 未带 Key'}
                      </span>}
                    </span>
                    {!d.ok && <span className="dr-src">请核对地址、协议和 Key 后重试；服务商不支持列表时，可按其文档手动填写“模型名称”。</span>}
                    {d.ok && d.models.length === 0 && <span className="dr-src">接口没有返回模型列表。请按服务商文档手动填写“模型名称”，然后保存。</span>}
                    {d.ok && d.models.length > 0 && (() => {
                      const hit = d.models.includes(r.model);
                      return (
                        <span className="dr-pick">
                          <Select
                            aria-label="获取的可用模型" value={hit ? r.model : ''}
                            placeholder={`选模型并填入名称（${d.models.length} 个）…`}
                            onChange={(model) => { if (model) ops?.onRow?.(i, { model }); }}
                            options={d.models.map((model) => ({ value: model, label: model }))}
                          />
                          <span className="dr-src">{hit ? `已填入“模型名称”：${r.model}；保存后写入配置。` : '选择后填入上方“模型名称”，仍需点击保存。'}</span>
                        </span>
                      );
                    })()}
                  </div>
                );
              })()}
              </div>
            </article>
          );
}

export function ProviderBoard({ rows, ops, modelLoading, resultText }: BoardProps & { rows: ModelRow[]; modelLoading: boolean }) {
  return (
    modelLoading && rows.length === 0 ? (
      <div className="board"><div className="empty"><span className="spin" /> 正在读取配置…<span className="hint">（后台繁忙时可能稍慢，会自动重试）</span></div></div>
    ) : rows.length === 0 ? (
      <div className="board"><div className="empty">还没有配置。<span className="hint">可在「环境安装」先补齐本地能力。</span></div></div>
    ) : (
      <div className="provider-list">
        {rows.map((r, i) => <ProviderCard key={`${r.slot || r.type}:${i}`} r={r} i={i} ops={ops} resultText={resultText} />)}
      </div>
    )
  );
}

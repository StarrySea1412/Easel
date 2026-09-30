import type { ModelRow, ModelPreset, DiscoverResult } from '../../lib/api';
import { SettingsField } from './SettingsField';
import Select from '../ui/Select';

export type ProviderBoardOptions = {
      onRow?: (i: number, patch: Partial<ModelRow>) => void;
      onPrimary?: (i: number) => void;
      onRemove?: (i: number) => void;
      media?: boolean;
      channel?: string;                    // 用于「获取模型」的通道标识
      presets?: ModelPreset[];             // 服务商预设（公开端点）
      discovery?: (i: number) => DiscoverResult | 'loading' | undefined;
      onDiscover?: (i: number) => void;
      onPickPreset?: (i: number, p: ModelPreset) => void;
      busyKey?: string;
    };

const SLOT_EDIT: Record<string, { model: boolean; base: boolean }> = {
  openai: { model: true, base: true }, relay: { model: true, base: true },
  anthropic: { model: true, base: true }, siliconflow: { model: false, base: true },
  custom: { model: true, base: true },
};
const hhmm = (ts: number) => new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

export function ProviderBoard({ rows, ops, modelLoading, resultText }: {
  rows: ModelRow[];
  ops?: ProviderBoardOptions;
  modelLoading: boolean;
  resultText: (row: ModelRow) => { text: string; cls: string };
}) {
  return (
    modelLoading && rows.length === 0 ? (
      <div className="board"><div className="empty"><span className="spin" /> 正在读取配置…<span className="hint">（后台繁忙时可能稍慢，会自动重试）</span></div></div>
    ) : rows.length === 0 ? (
      <div className="board"><div className="empty">还没有配置。<span className="hint">可在「环境安装」先补齐本地能力。</span></div></div>
    ) : (
      <div className="provider-list">
        {rows.map((r, i) => {
          const rt = resultText(r);
          const ed = SLOT_EDIT[r.slot || '']
            || (ops?.media && r.slot
              ? { model: r.modelEditable !== false, base: r.baseEditable !== false }
              : undefined);
          const isCustom = r.slot === 'custom';
          return (
            <article className="provider-card" key={i}>
              <div className="provider-head">
              <span className={`step${r.order === 0 ? ' ghost' : ''}`}>{isCustom ? i + 1 : r.order}</span>
              {isCustom ? (
                <span className="provider-heading">
                  <input
                    className="mock"
                    value={r.name}
                    placeholder="名称"
                    aria-label="供应商名称"
                    onChange={(e) => ops?.onRow?.(i, { name: e.target.value.toLowerCase() })}
                  />
                </span>
              ) : (
                <span className="provider-heading">{r.name}<small>{r.sub}</small></span>
              )}
              <span className="tag backup">{r.type}</span>
              </div>
              <div className="provider-fields">
              <SettingsField label="模型">
              {ed && ed.model && (!ops?.media || r.adv) ? (
                <span className="key-stack">
                  <Select
                    value=""
                    aria-label="服务商预设"
                    disabled={!(ops?.presets || []).length}
                    placeholder={(ops?.presets || []).length ? '服务商预设…' : '暂无预设（手动填写）'}
                    onChange={(value) => {
                      const p = (ops?.presets || []).find((x) => x.id === value);
                      if (p) ops?.onPickPreset?.(i, p);
                    }}
                    options={(ops?.presets || []).map((preset) => ({ value: preset.id,
                      label: preset.name, description: preset.note,
                      disabled: ops?.channel === 'chat' && r.slot !== 'custom'
                        && preset.protocol !== (r.slot === 'openai' ? 'openai' : 'anthropic'),
                    }))}
                  />
                  <span className="model-fetch">
                    <input
                      className="mock"
                      aria-label="模型名称"
                      value={r.model}
                      placeholder={isCustom ? '模型名' : ''}
                      onChange={(e) => ops?.onRow?.(i, { model: e.target.value })}
                    />
                    {ops?.onDiscover && <button
                      className="adv-btn"
                      title="向该服务商获取可用模型列表（用地址 + 已保存或刚填的 Key）"
                      disabled={ops?.busyKey === `${ops?.channel}:${i}`}
                      onClick={() => ops?.onDiscover?.(i)}
                    >
                      {ops?.busyKey === `${ops?.channel}:${i}` ? '获取中…' : '获取模型'}
                    </button>}
                  </span>
                </span>
              ) : (
                <span className={`cell-text${ops?.media && !r.model ? ' dim' : ''}`} title={r.model || '内建默认'}>
                  {r.model || (ops?.media ? '默认（内建）' : '')}
                </span>
              )}
              </SettingsField>
              <SettingsField label="Base URL">
              {ed && ed.base && (!ops?.media || r.adv) ? (
                <input className="mock" aria-label="Base URL" value={r.baseUrl} placeholder="https://…" onChange={(e) => ops?.onRow?.(i, { baseUrl: e.target.value })} />
              ) : (
                <span className={`cell-text${ops?.media && !r.baseUrl ? ' dim' : ''}`} title={r.baseUrl || '内建默认'}>
                  {r.baseUrl
                    || (ops?.media
                      ? r.baseOptional === false
                        ? '需填写（点「高级」）'
                        : '默认（内建）'
                      : '')}
                </span>
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
                      placeholder={r.keyMasked || 'Key'}
                      onChange={(e) => ops?.onRow?.(i, { keyNew: e.target.value })}
                    />
                    <input
                      className="mock key-input"
                      type="password"
                      aria-label={r.key2Label} value={r.keyNew2 || ''}
                      placeholder={r.key2Masked || r.key2Label}
                      onChange={(e) => ops?.onRow?.(i, { keyNew2: e.target.value })}
                    />
                  </span>
                ) : (
                  <input
                    className="mock key-input"
                    type="password"
                    aria-label="API Key" value={r.keyNew || ''}
                    placeholder={r.keyMasked || '粘贴 Key'}
                    onChange={(e) => ops?.onRow?.(i, { keyNew: e.target.value })}
                  />
                )
              ) : (
                <span className="cell-text key-mask" title="密钥不显示明文">{r.keyMasked || '—'}</span>
              )}
              </SettingsField>
              </div>
              <div className="provider-status">
              {r.slot && ops?.onPrimary ? (
                <button
                  className={`tag ${r.role === '主' ? 'main' : 'backup'}`}
                  onClick={() => ops.onPrimary?.(i)}
                  title="设为主通道"
                >
                  {r.role}
                </button>
              ) : (
                <span className={`tag ${r.role === '主' ? 'main' : 'backup'}`}>{r.role}</span>
              )}
              <span className={`stt ${rt.cls}`}>{rt.text}</span>
              {isCustom && ops?.onRemove ? (
                <button className="row-del" onClick={() => ops.onRemove?.(i)} title="删除该供应商">✕</button>
              ) : ops?.media && r.slot ? (
                <button className="adv-btn" onClick={() => ops?.onRow?.(i, { adv: !r.adv })}>
                  {r.adv ? '收起' : '高级'}
                </button>
              ) : (
                <span />
              )}
              </div>
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
                    {!d.ok && <span className="dr-src">可继续手动填写模型名</span>}
                    {d.ok && (() => {
                      const hit = d.models.includes(r.model);
                      return (
                        <span className="dr-pick">
                          <Select
                            aria-label="获取的可用模型" value={hit ? r.model : ''}
                            placeholder={`选择模型（${d.models.length} 个）…`}
                            onChange={(model) => { if (model) ops?.onRow?.(i, { model }); }}
                            options={d.models.map((model) => ({ value: model, label: model }))}
                          />
                          {!hit && d.models.length > 0 && <button className="adv-btn" onClick={() => ops?.onRow?.(i, { model: d.models[0] })}>填入第一个</button>}
                        </span>
                      );
                    })()}
                  </div>
                );
              })()}
            </article>
          );
        })}
      </div>
    )
  );
}

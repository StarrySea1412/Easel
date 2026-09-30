import type { ModelRow } from '../../lib/api';
import { useModelImport } from '../../hooks/useModelImports';
import Select from '../ui/Select';
import { SettingsField } from './SettingsField';

const SLOT_OPTIONS = [
  { value: 'openai', label: 'OpenAI 兼容', description: '适用于 Chat Completions 协议' },
  { value: 'relay', label: 'Anthropic 兼容中转', description: '适用于 Anthropic Messages 协议' },
  { value: 'anthropic', label: 'Anthropic', description: '适用于 Anthropic Messages 协议' },
];

export function ModelConfigPicker({ rows, disabled, onPrimary, onApplied, onBusyChange, onOpenImport }: {
  rows: ModelRow[];
  disabled: boolean;
  onPrimary: (index: number) => void;
  onApplied: (row: ModelRow) => void;
  onBusyChange: (busy: boolean) => void;
  onOpenImport: () => void;
}) {
  const state = useModelImport({ onApplied, onBusyChange });
  const primary = rows.findIndex((row) => row.role === '主');
  const locked = disabled || Boolean(state.busy);
  return (
    <section className="model-config-picker" aria-label="选择模型配置">
      <div className="provider-head">
        <div className="provider-heading"><h3>选择模型配置</h3><small>已导入的配置可直接切换；也可从 CC Switch / OpenClaw 选择模型。</small></div>
        <button type="button" className="adv-btn" disabled={locked || state.loadingSources} onClick={() => void state.refreshSources()}>
          {state.loadingSources ? '检测来源…' : '刷新来源'}
        </button>
      </div>
      <div className="provider-fields">
        <SettingsField label="配置来源">
          <Select aria-label="配置来源" value={state.source} disabled={locked}
            options={[
              { value: 'saved', label: '当前配置（含已导入）', description: '使用已保存的供应商和密钥' },
              ...state.sources.map((source) => ({ value: source.id, label: source.label,
                description: source.available ? '已检测到 · 选择后读取模型' : '未检测到 · 可到配置导入指定路径', disabled: !source.available })),
            ]}
            onChange={(source) => void state.read(source, state.slot)} />
        </SettingsField>
        {state.source === 'saved' ? (
          <SettingsField label="主模型">
            <Select aria-label="主模型" value={primary >= 0 ? String(primary) : ''} disabled={locked}
              placeholder="选择已配置模型"
              options={rows.flatMap((row, index) => row.slot ? [{ value: String(index),
                label: `${row.name || '未命名供应商'} · ${row.model || '未填写模型'}`,
                description: row.keyMasked && row.keyMasked !== '—' ? row.baseUrl : '尚未配置密钥',
                disabled: (!row.keyMasked || row.keyMasked === '—') && !row.keyNew,
              }] : [])}
              onChange={(index) => onPrimary(Number(index))} />
          </SettingsField>
        ) : (
          <SettingsField label="导入到">
            <Select aria-label="导入目标通道" value={state.slot} disabled={locked} options={SLOT_OPTIONS}
              onChange={(slot) => void state.read(state.source, slot)} />
          </SettingsField>
        )}
      </div>
      {state.source === 'saved' ? (
        <p className="hint">切换主模型后，点击右上角「保存配置」生效。下方可继续编辑模型、地址和密钥。</p>
      ) : (
        <div className="model-import-options">
          <SettingsField label="来源中的模型">
            <Select aria-label="来源中的模型" value={state.pick} disabled={locked || !state.preview?.candidates.length}
              placeholder={state.busy === 'preview' ? '正在读取模型…' : '选择要导入的模型'}
              options={(state.preview?.candidates || []).map((candidate) => ({ value: candidate.id,
                label: `${candidate.name} · ${candidate.model || '未指定模型'}`,
                description: candidate.compatible ? `${candidate.protocol} · ${candidate.baseUrl}` : candidate.skipReason,
                disabled: !candidate.compatible,
              }))} onChange={state.selectCandidate} />
          </SettingsField>
          {state.preview && !state.preview.candidates.some((candidate) => candidate.compatible) && state.preview.candidates.length > 0 && (
            <p className="hint">此来源没有匹配当前通道的配置。请切换导入目标；不兼容原因见模型选项。</p>
          )}
          {state.selected && (
            <div className="model-import-preview">
              <p><strong>{state.selected.name}</strong> · {state.selected.model || '保留目标模型'}</p>
              <p className="hint">{state.selected.baseUrl} · 密钥 {state.selected.keyMasked || '未配置'}</p>
              {state.selected.overwrites.length > 0 && <ul>{state.selected.overwrites.map((overwrite) => (
                <li key={overwrite.field}><strong>{overwrite.field}</strong>：{overwrite.current} → {overwrite.incoming}</li>
              ))}</ul>}
              {state.selected.note && <p className="hint">{state.selected.note}</p>}
              <label className="model-import-confirm"><input type="checkbox" checked={state.confirmed} disabled={locked}
                onChange={(event) => state.setConfirmed(event.target.checked)} />已核对覆盖内容，导入并替换此通道未保存的编辑</label>
            </div>
          )}
          <div className="model-picker-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={locked || !state.selected?.compatible || !state.confirmed}
              onClick={() => void state.apply()}>{state.busy === 'apply' ? '导入中…' : '导入所选模型'}</button>
            <button type="button" className="adv-btn" disabled={locked} onClick={() => void state.read(state.source, state.slot)}>重新读取候选</button>
          </div>
          {state.preview?.errors.length ? <p className="hint">部分条目未读取：{state.preview.errors.join('；')}</p> : null}
        </div>
      )}
      {state.message && <p role="status" className="model-picker-message">{state.message}</p>}
      <button type="button" className="adv-btn" disabled={locked} onClick={onOpenImport}>指定配置文件路径 / 查看完整导入</button>
    </section>
  );
}

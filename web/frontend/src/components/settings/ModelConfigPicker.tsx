import type { ModelRow } from '../../lib/api';
import Select from '../ui/Select';
import { SettingsField } from './SettingsField';

export function ModelConfigPicker({ rows, savedPrimary, disabled, saving, dirty, saveNote, labelFor, onPrimary, onSave, onOpenImport }: {
  rows: ModelRow[];
  savedPrimary?: ModelRow;
  disabled: boolean;
  saving: boolean;
  dirty: boolean;
  saveNote: string;
  labelFor: (row?: ModelRow) => string;
  onPrimary: (index: number) => void;
  onSave: () => void;
  onOpenImport: () => void;
}) {
  const primary = rows.findIndex((row) => row.role === '主');
  const selected = rows[primary];
  return (
    <section className="model-config-picker" aria-label="默认对话模型">
      <div className="provider-head">
        <div className="provider-heading"><h3>默认对话模型</h3><small>选模型 → 保存并使用；已有配置可直接切换。</small></div>
      </div>
      <div className="model-default-current">
        <span>已保存默认</span><strong>{labelFor(savedPrimary)}</strong>
        {savedPrimary && (!savedPrimary.keyMasked || savedPrimary.keyMasked === '—') && <small>此通道尚未配置密钥</small>}
      </div>
      <SettingsField label={dirty ? '待保存主模型' : '选择主模型'}>
        <Select aria-label="主模型" value={primary >= 0 ? String(primary) : ''} disabled={disabled}
          placeholder="选择已配置模型"
          options={rows.flatMap((row, index) => row.slot ? [{ value: String(index),
            label: labelFor(row),
            description: row.keyMasked && row.keyMasked !== '—' ? row.baseUrl : '尚未配置密钥',
            disabled: (!row.keyMasked || row.keyMasked === '—') && !row.keyNew,
          }] : [])}
          onChange={(index) => onPrimary(Number(index))} />
      </SettingsField>
      <p className={`hint${dirty ? ' model-default-pending' : ''}`} aria-live="polite">
        {dirty ? `待保存：${labelFor(selected)}。保存前仍使用已保存默认：${labelFor(savedPrimary)}。`
          : '设置默认用于后续未单独指定模型的请求；对话输入框选择仅用于当前请求。'}
      </p>
      <div className="model-picker-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={disabled || !dirty}
          onClick={onSave}>{saving ? '保存中…' : '保存并使用'}</button>
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={onOpenImport}>从 CC Switch / Magpie / OpenClaw 导入</button>
      </div>
      {dirty && <p className="hint">保存默认后，输入框里手动选过的模型仍按本轮选择；切回“沿用会话模型”即可使用新默认。</p>}
      {saveNote && <p role={saveNote.startsWith('保存失败') ? 'alert' : 'status'}
        className={`model-picker-message${saveNote.startsWith('保存失败') ? ' err' : ''}`}>{saveNote}</p>}
    </section>
  );
}

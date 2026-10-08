import { NativeSelect as Select } from '../ui/Select';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_EMPLOYEE_APPEARANCES, type EmployeeAppearance } from '../../lib/employeeAppearance';
import './office-appearance-editor.css';

export default function OfficeAppearanceEditor({ draft, original, agentName, agentId, live, sharedCount, onChange, onSave, onCancel }: {
  draft: EmployeeAppearance; original: EmployeeAppearance; agentName: string; agentId: string; live: boolean; sharedCount: number;
  onChange: (card: EmployeeAppearance) => void; onSave: (card: EmployeeAppearance) => void; onCancel: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ onCancel });
  callbacks.current = { onCancel };
  const titleId = useId();
  const descriptionId = useId();
  const [error, setError] = useState('');
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  const change = (patch: Partial<EmployeeAppearance>) => { onChange({ ...draft, ...patch }); setError(''); };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus({ preventScroll: true });
    const focusable = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]):not([aria-hidden="true"]), [tabindex="0"]') || []);
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Let an open combobox consume Escape before the editor cancels its draft.
      if (event.key === 'Escape' && target?.getAttribute?.('role') === 'combobox' && target.getAttribute('aria-expanded') === 'true') return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); callbacks.current.onCancel(); return; }
      if (event.key !== 'Tab') return;
      const elements = focusable(), first = elements[0], last = elements.at(-1);
      if (!first) { event.preventDefault(); panel.current?.focus({ preventScroll: true }); return; }
      if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus({ preventScroll: true }); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus({ preventScroll: true }); }
    };
    const focusin = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) closeButton.current?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focusin);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(<div className="office-appearance-overlay">
    <section className="office-appearance-editor" ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
      <header><div><p>角色自定义</p><h2 id={titleId}>让这位同事更像你想的样子</h2></div><button type="button" ref={closeButton} aria-label="取消编辑并关闭" onClick={onCancel}>×</button></header>
      <p className="office-editor-preview-note" id={descriptionId}>修改会立即预览在办公室中，点击保存后才应用到角色卡。取消会恢复原来的外观。</p>
      <form noValidate onSubmit={event => { event.preventDefault(); try { onSave(draft); } catch (cause) { setError(cause instanceof Error ? cause.message : '角色卡没有保存，请检查填写内容。'); } }}>
        <div className="office-editor-fields"><label>显示名<input value={draft.name} maxLength={24} required onChange={event => change({ name: event.target.value })} /></label><label>显示岗位<input value={draft.role} maxLength={40} required onChange={event => change({ role: event.target.value })} /></label></div>
        <fieldset className="office-editor-species"><legend>动物形象</legend>{([
          ['cat', '小猫', '圆脸 · 尖耳'], ['rabbit', '兔子', '长耳 · 轻巧'], ['fox', '狐狸', '尖脸 · 蓬尾'], ['bear', '小熊', '圆耳 · 厚实'],
        ] as const).map(([value, label, hint]) => <button type="button" key={value} aria-pressed={draft.species === value} onClick={() => change({ species: value })}><strong>{label}</strong><small>{hint}</small></button>)}</fieldset>
        <fieldset className="office-editor-colors"><legend>搭配颜色</legend>{([
          ['shirtColor', '服装颜色'], ['skinColor', '毛色'], ['hairColor', '点缀颜色'],
        ] as const).map(([key, label]) => <label key={key}><input type="color" value={draft[key]} aria-label={label} onChange={event => change({ [key]: event.target.value })} /><span>{label}<small>{draft[key].toUpperCase()}</small></span></label>)}</fieldset>
        <label className="office-editor-accessory">配饰<Select value={draft.accessory} onChange={event => change({ accessory: event.target.value as EmployeeAppearance['accessory'] })}><option value="none">无配饰</option><option value="glasses">眼镜</option><option value="headset">耳机</option></Select></label>
        <div className="office-editor-scope"><strong>这是展示形象，不是 Agent 的工作指令</strong><p>显示岗位不会改变提示词、技能、权限或任务。{live ? '真实身份始终保留：' : '当前模拟角色：'}{agentName}（{agentId}）。</p><p>{draft.id === 'generic' ? '这张是实时 Agent 的通用角色卡；未手动绑定的 Agent 仍显示真实名称。' : `正在编辑「${original.name}」角色卡。`}{sharedCount > 1 ? ` 当前有 ${sharedCount} 位成员使用它，保存后会一起更新。` : ' 保存会更新之后使用此卡的角色。'}</p></div>
        {error && <p className="office-editor-error" role="alert">{error}</p>}
        <footer><button type="button" className="office-editor-reset" onClick={() => { onChange({ ...DEFAULT_EMPLOYEE_APPEARANCES.find(card => card.id === draft.id)! }); setError(''); }}>恢复此卡默认</button><p role="status">{dirty ? '正在预览 · 尚未保存' : '修改将在场景中实时预览'}</p><div><button type="button" className="btn" onClick={onCancel}>取消</button><button type="submit" className="btn btn-primary">保存角色卡</button></div></footer>
      </form>
    </section>
  </div>, document.body);
}

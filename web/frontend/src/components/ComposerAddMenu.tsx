import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconFile, IconImage, IconOutputs, IconPlus, IconSkills } from './icons';

export type ComposerUploadKind = 'media' | 'files' | 'folder';
export default function ComposerAddMenu({ disabled, uploading, onUpload, onSkills }: {
  disabled: boolean; uploading: boolean; onUpload: (kind: ComposerUploadKind) => void; onSkills: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12, maxHeight: 300 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const id = useId(), visible = open && !disabled;
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect(), height = menu.current?.offsetHeight || 230;
      const above = rect.top - height - 8;
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 260 - 12)),
        top: Math.max(12, Math.min(above >= 12 ? above : rect.bottom + 8, window.innerHeight - height - 12)), maxHeight: window.innerHeight - 24 });
    };
    place(); menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(true); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [visible]);
  const choose = (action: () => void) => { close(); action(); };
  return <><button ref={trigger} type="button" className="composer-attach-btn" disabled={disabled}
    aria-label={uploading ? '正在添加素材' : '添加素材或技能'} aria-haspopup="menu" aria-expanded={visible} aria-controls={visible ? id : undefined}
    title="添加图片、视频、文件或创作技能" onClick={() => setOpen(value => !value)}><IconPlus size={18}/>{uploading && <span>上传中…</span>}</button>
    {visible && createPortal(<div ref={menu} id={id} role="menu" aria-label="添加" className="composer-add-menu" style={position} onKeyDown={event => {
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      } else if (event.key === 'Tab') close();
    }}>
      <small>添加</small>
      <button type="button" role="menuitem" onClick={() => choose(() => onUpload('media'))}><IconImage size={17}/><span>图片或视频<small>添加参考图、视频素材</small></span></button>
      <button type="button" role="menuitem" onClick={() => choose(() => onUpload('files'))}><IconFile size={17}/><span>文件<small>文档、表格、PDF、音频等</small></span></button>
      <button type="button" role="menuitem" onClick={() => choose(() => onUpload('folder'))}><IconOutputs size={17}/><span>文件夹内素材<small>添加文件夹中支持的文件</small></span></button>
      <hr/>
      <button type="button" role="menuitem" onClick={() => choose(onSkills)}><IconSkills size={17}/><span>创作技能<small>选择本机已安装的技能</small></span></button>
    </div>, document.body)}
  </>;
}

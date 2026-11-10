import { useEffect, useRef, useState } from 'react';
import { saveSkillPrompt, type SkillDetail } from '../lib/api';

export default function SkillPromptEditor({ detail, onSaved }: { detail: SkillDetail; onSaved: (value: SkillDetail) => void }) {
  const [editing, setEditing] = useState(false), [body, setBody] = useState(detail.body);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [note, setNote] = useState('');
  const input = useRef<HTMLTextAreaElement>(null), controller = useRef<AbortController | null>(null), pending = useRef(false);
  const editButton = useRef<HTMLButtonElement>(null), wasEditing = useRef(false);
  // A local draft survives closing the picker or hovering another skill, but never crosses skills.
  const draftKey = `easel:skill-prompt-draft:${detail.name}`;
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (editing) input.current?.focus(); else if (wasEditing.current) editButton.current?.focus(); wasEditing.current = editing; }, [editing]);
  const begin = () => {
    let draft = detail.body;
    try { draft = window.sessionStorage.getItem(draftKey) ?? draft; } catch { /* Storage may be unavailable. */ }
    setBody(draft); setEditing(true); setError(''); setNote('');
  };
  const change = (value: string) => { setBody(value); try { window.sessionStorage.setItem(draftKey, value); } catch { /* Input remains editable. */ } };
  const clearDraft = () => { try { window.sessionStorage.removeItem(draftKey); } catch { /* No persistent draft. */ } };
  const save = async () => {
    if (pending.current || !body.trim() || !detail.promptRevision) return;
    pending.current = true; setBusy(true); setError('');
    const request = new AbortController(); controller.current = request;
    const timeout = setTimeout(() => request.abort(), 12000);
    try {
      const value = await saveSkillPrompt(detail.name, body, detail.promptRevision, request.signal);
      if (request.signal.aborted) return;
      if (value.name !== detail.name || value.body !== body || !value.promptRevision) throw new Error('保存回执不一致，请重新读取后核对；输入已保留。');
      onSaved(value); clearDraft(); setEditing(false); setNote('提示词已保存，下次调用此技能时生效');
    } catch (reason) { setError(request.signal.aborted ? '保存等待超时，输入已保留；请重新读取核对后重试。' : reason instanceof Error ? reason.message : '保存失败，输入已保留。'); }
    finally { clearTimeout(timeout); pending.current = false; setBusy(false); }
  };
  return <section className="skill-prompt-editor" aria-label="技能提示词">
    <header><strong>技能提示词</strong><span>{detail.promptCustomized ? '已自定义' : '安装版本'}</span></header>
    {editing ? <><label htmlFor={`skill-prompt-${detail.name}`}>修改技能正文</label><textarea id={`skill-prompt-${detail.name}`} ref={input} value={body} readOnly={busy} maxLength={100000} onChange={event => change(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void save(); } }}/>
      <div className="skill-prompt-actions"><button type="button" className="btn btn-primary btn-sm" disabled={busy || !body.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存提示词'}</button><button type="button" className="btn btn-sm" disabled={busy} onClick={() => { clearDraft(); setBody(detail.body); setEditing(false); setError(''); }}>取消</button></div>
    </> : <><button ref={editButton} type="button" className="btn btn-sm" disabled={!detail.promptRevision} onClick={begin}>修改提示词</button><details><summary>查看完整提示词</summary><pre>{detail.body}</pre></details></>}
    {error && <p role="alert">{error}</p>}{note && <p role="status">{note}</p>}
  </section>;
}

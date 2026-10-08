import { useState, useEffect, useCallback, useMemo } from 'react';
import { fetchIdeas, createIdea, updateIdea, deleteIdea, createSchedule } from '../lib/api';
import type { Idea, IdeaInput } from '../lib/api';
import { IconIdea, IconEdit, IconTrash, IconChat, IconCalendar, IconChevron } from './icons';
import { useModalFocus } from '../hooks/useModalFocus';

interface IdeasPageProps {
  onUseTopic: (title: string) => void;
}

const COLUMNS: { key: string; label: string; color: string }[] = [
  { key: 'pending', label: '待做', color: 'var(--text-tertiary)' },
  { key: 'doing', label: '进行中', color: 'var(--layer-attribute)' },
  { key: 'done', label: '已完成', color: 'var(--layer-publish)' },
];
const NEXT: Record<string, string> = { pending: 'doing', doing: 'done', done: 'pending' };
const EMPTY: IdeaInput = { title: '', note: '', source: '', status: 'pending' };

export default function IdeasPage({ onUseTopic }: IdeasPageProps) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [form, setForm] = useState<IdeaInput | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const closeForm = useCallback(() => setForm(null), []);
  const modalRef = useModalFocus(form !== null, closeForm);

  const load = useCallback(() => {
    setLoading(true); setError('');
    fetchIdeas().then(setIdeas).catch(() => setError('选题加载失败，请重试。')).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 2200); };
  const byStatus = useMemo(() => {
    const g: Record<string, Idea[]> = { pending: [], doing: [], done: [] };
    for (const it of ideas) (g[it.status] || g.pending).push(it);
    return g;
  }, [ideas]);

  const openNew = () => { setError(''); setEditId(null); setForm({ ...EMPTY }); };
  const openEdit = (it: Idea) => { setError(''); setEditId(it.id); setForm({ title: it.title, note: it.note, source: it.source, status: it.status }); };
  const save = async () => {
    if (!form || !form.title.trim() || saving) return;
    setSaving(true); setError('');
    try {
      if (editId) await updateIdea(editId, form); else await createIdea(form);
      setForm(null); setEditId(null); load();
    } catch { setError('选题保存失败，内容已保留，请重试。'); }
    finally { setSaving(false); }
  };
  const advance = async (it: Idea) => {
    try { await updateIdea(it.id, { ...it, status: NEXT[it.status] || 'doing' }); load(); }
    catch { setError('更新选题状态失败，请重试。'); }
  };
  const remove = async (it: Idea) => {
    try { await deleteIdea(it.id); load(); }
    catch { setError('删除选题失败，请重试。'); }
  };
  const schedule = async (it: Idea) => {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    try {
      await createSchedule({ title: it.title, date, platform: '', time: '', status: 'idea', note: it.note });
      showToast('已加入日历（今天）');
    } catch { setError('加入日历失败，请重试。'); }
  };

  return (
    <div className="page-scroll ideas-page">
      <div className="page-head">
        <div>
          <h1 className="page-title"><IconIdea size={21} /> 选题库</h1>
          <p className="page-subtitle">攒住每一个灵感——从热点收藏或手动新增，推进到「做内容」再进日历。</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-sm" onClick={load} disabled={loading}>{loading ? '加载中…' : '刷新'}</button>
          <button className="btn btn-sm btn-primary" onClick={openNew}>+ 新建选题</button>
        </div>
      </div>

      {error && !form && <div className="notice-error" role="alert">{error}</div>}

      <div className="kanban">
        {COLUMNS.map((col) => (
          <div key={col.key} className="kanban-col">
            <div className="kanban-col-head">
              <span className="kanban-dot" style={{ background: col.color }} />
              {col.label}<span className="kanban-count">{byStatus[col.key].length}</span>
            </div>
            <div className="kanban-list">
              {byStatus[col.key].length === 0 && <div className="kanban-empty">{loading ? '正在加载选题…' : error ? '选题尚未加载' : '暂无选题，可新建或从热点收藏'}</div>}
              {byStatus[col.key].map((it) => (
                <div key={it.id} className="card idea-card">
                  <div className="idea-card-head">
                    <div className="idea-title">{it.title}</div>
                    <div className="idea-card-actions">
                      <button className="session-act" title="编辑" aria-label={`编辑选题：${it.title}`} onClick={() => openEdit(it)}><IconEdit size={13} /></button>
                      <button className="session-act danger" title="删除" aria-label={`删除选题：${it.title}`} onClick={() => remove(it)}><IconTrash size={13} /></button>
                    </div>
                  </div>
                  {it.source && <span className="badge" style={{ marginTop: 6 }}>{it.source}</span>}
                  {it.note && <div className="idea-note">{it.note}</div>}
                  <div className="idea-foot">
                    <button className="idea-act" onClick={() => onUseTopic(it.title)}><IconChat size={13} /> 做内容</button>
                    <button className="idea-act" onClick={() => schedule(it)}><IconCalendar size={13} /> 排期</button>
                    <button className="idea-act next" onClick={() => advance(it)} title="推进状态">
                      {COLUMNS.find((c) => c.key === NEXT[it.status])?.label} <IconChevron size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {form && (
        <div className="overlay" onClick={closeForm}>
          <div ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-label={editId ? '编辑选题' : '新建选题'} tabIndex={-1} style={{ width: 440, maxWidth: '100%' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <h3 style={{ margin: 0 }}>{editId ? '编辑选题' : '新建选题'}</h3>
              <button className="icon-btn" aria-label="关闭选题表单" onClick={closeForm}>×</button>
            </div>
            {error && <div className="notice-error" role="alert">{error}</div>}
            <label className="field-label">选题 *</label>
            <input className="field" value={form.title} data-modal-autofocus="true" placeholder="想做的内容 / 角度"
              onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <label className="field-label">备注 / 角度</label>
            <textarea className="field" style={{ minHeight: 70 }} value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })} />
            <label className="field-label">来源</label>
            <input className="field" value={form.source} placeholder="如：微博热搜 / 灵感"
              onChange={(e) => setForm({ ...form, source: e.target.value })} />
            <label className="field-label">状态</label>
            <div className="modal-choice-row">
              {COLUMNS.map((c) => (
                <button key={c.key} className={`chip ${form.status === c.key ? 'active' : ''}`}
                  onClick={() => setForm({ ...form, status: c.key })}>{c.label}</button>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn btn-sm" onClick={closeForm}>取消</button>
              <button className="btn btn-sm btn-primary" onClick={save} disabled={saving || !form.title.trim()}>{saving ? '保存中…' : '保存'}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast ok"><span className="toast-icon">✓</span>{toast}</div>}
    </div>
  );
}

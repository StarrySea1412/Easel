import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChatQuestion, ChatQuestionItem } from '../lib/api';
import { answerQuestion } from '../lib/api';

function formatRemaining(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** One explicit submission answers every question; expiry never chooses an answer. */
function QuestionCard({ question, onAnswered }: { question: ChatQuestion; onAnswered: () => void }) {
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now);
  const fieldId = useId();
  const expires = typeof question.expiresAtMs === 'number' && Number.isFinite(question.expiresAtMs)
    && question.expiresAtMs > 0 ? question.expiresAtMs : undefined;
  const remaining = expires === undefined ? undefined : Math.max(0, Math.ceil((expires - now) / 1000));
  const expired = remaining === 0;

  useEffect(() => {
    if (expires === undefined) return;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [expires]);

  const items = question.questions || [];
  const answers: Record<string, string[]> = {};
  for (const item of items) {
    const text = (custom[item.questionId] || '').trim();
    const values = selected[item.questionId] || [];
    answers[item.questionId] = text
      ? item.multiSelect ? [...new Set([...values, text])] : [text]
      : values;
  }
  const answeredCount = items.filter(item => answers[item.questionId].length > 0).length;
  const allAnswered = items.length > 0 && answeredCount === items.length;

  const pick = (item: ChatQuestionItem, label: string) => {
    if (busy || expired) return;
    setSelected(previous => {
      const values = previous[item.questionId] || [];
      return { ...previous, [item.questionId]: item.multiSelect
        ? values.includes(label) ? values.filter(value => value !== label) : [...values, label]
        : [label] };
    });
    if (!item.multiSelect) setCustom(previous => ({ ...previous, [item.questionId]: '' }));
  };

  const submit = async () => {
    if (submitting.current || !allAnswered) return;
    // Recheck wall time even if the tab was throttled before the next timer tick.
    if (expires !== undefined && Date.now() >= expires) { setNow(Date.now()); return; }
    submitting.current = true;
    setBusy(true); setError('');
    try {
      const result = await answerQuestion({ questionId: question.id, answers });
      if (!result.ok) setError(result.error || '提交失败，请重试');
      else onAnswered();
    } catch {
      setError('回复未能提交，已保留填写内容，请重试。');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="message-row assistant">
      <div className="msg-col assistant question-card__column">
        <form className="question-card" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <div className="question-card__status">
            <span>{expired ? '本次提问已到期' : busy ? '正在提交回复' : '等待你的回复'}</span>
            {remaining !== undefined && <span className={`question-card__timer${remaining <= 60 ? ' question-card__timer--urgent' : ''}`}
              role="timer" aria-live="off" aria-label={expired ? '回复时间已到期' : `回复剩余 ${formatRemaining(remaining)}`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
              {expired ? '已到期' : `剩余 ${formatRemaining(remaining)}`}
            </span>}
          </div>
          {items.map((item, index) => {
            const options = item.options || [];
            const values = selected[item.questionId] || [];
            return (
              <div key={item.questionId} className="question-card__item">
                {index > 0 && <div className="question-card__divider" />}
                {item.header && <div className="question-card__chip">{item.header}</div>}
                <div className="question-card__title">
                  {item.question || '请选择'}
                  {item.multiSelect && <span className="question-card__multi">可多选</span>}
                </div>
                <div className="question-card__options">
                  {options.map(option => (
                    <button key={option.label} type="button"
                      className={`question-card__option${values.includes(option.label) ? ' question-card__option--selected' : ''}`}
                      aria-pressed={values.includes(option.label)} disabled={busy || expired}
                      onClick={() => pick(item, option.label)}>
                      <strong>{option.label}</strong>
                      {option.description && <span>{option.description}</span>}
                    </button>
                  ))}
                </div>
                <div className="question-card__custom">
                  <label htmlFor={`${fieldId}-${index}`}>{options.length ? '或直接输入' : '你的回答'}</label>
                  <textarea id={`${fieldId}-${index}`} rows={2}
                    value={custom[item.questionId] || ''} readOnly={busy || expired}
                    placeholder={item.multiSelect ? '补充其他选择…' : '输入你的想法…'}
                    onChange={event => {
                      if (busy || expired) return;
                      const value = event.target.value;
                      setCustom(previous => ({ ...previous, [item.questionId]: value }));
                      if (!item.multiSelect && value.trim()) setSelected(previous => ({ ...previous, [item.questionId]: [] }));
                    }}
                    onKeyDown={event => {
                      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault(); void submit();
                      }
                    }} />
                </div>
              </div>
            );
          })}
          <div className="question-card__actions">
            <span className="question-card__hint">{expired ? '未自动提交；填写内容已保留，可复制后在对话中继续回复。'
              : items.length > 1 ? `${answeredCount}/${items.length} 个问题已填写` : ''}</span>
            <button type="submit" className="question-card__submit" disabled={busy || expired || !allAnswered}>
              {busy ? '提交中…' : '提交'}
            </button>
          </div>
          {error && <div className="question-card__hint question-card__error" role="alert">{error}</div>}
        </form>
      </div>
    </div>
  );
}

/** Live and replayed questions share the same absolute deadline. */
export default function QuestionCards({ questions, onDone }: { questions: ChatQuestion[]; onDone?: (questionId: string) => void }) {
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const visible = useMemo(() => questions.filter(question => !answered[question.id]), [questions, answered]);
  if (!visible.length) return null;
  return <>{visible.map(question => (
    <QuestionCard key={question.id} question={question} onAnswered={() => {
      setAnswered(previous => ({ ...previous, [question.id]: true }));
      onDone?.(question.id);
    }} />
  ))}</>;
}

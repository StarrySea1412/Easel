import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChatQuestion, ChatQuestionItem } from '../lib/api';
import { answerQuestion } from '../lib/api';

function formatRemaining(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** 30s 无操作后自动选推荐项，避免 agent 一直等回复把对话挂住。 */
export const AUTO_PICK_MS = 30_000;
/** 自动提交的来源标记，便于审计区分「人选的」和「超时选的」。 */
export const AUTO_RESOLVED_BY = 'auto-timeout';
/** 标签页提醒前缀，切到别的 tab 也能看到还有问题没答。 */
export const TAB_NOTICE_PREFIX = '● ';

/** 推荐项：显式标记优先，否则取首个选项（ask_user 约定把推荐项放第一位）。 */
export function recommendedLabel(item: ChatQuestionItem): string | null {
  const options = item.options || [];
  if (!options.length) return null;
  const marked = options.find(option => option.recommended);
  return (marked || options[0]).label;
}

/**
 * 把当前填写状态整理成答案。
 * fillRecommended=true 时给未作答的题补推荐项；补不齐则返回 null（不猜）。
 */
export function resolveAnswers(
  items: ChatQuestionItem[],
  selected: Record<string, string[]>,
  custom: Record<string, string>,
  fillRecommended: boolean,
): Record<string, string[]> | null {
  const answers: Record<string, string[]> = {};
  for (const item of items) {
    const text = (custom[item.questionId] || '').trim();
    const values = selected[item.questionId] || [];
    if (text) {
      answers[item.questionId] = item.multiSelect ? [...new Set([...values, text])] : [text];
    } else if (values.length) {
      answers[item.questionId] = values;
    } else if (fillRecommended) {
      const label = recommendedLabel(item);
      if (label) answers[item.questionId] = [label];
    }
  }
  return items.length > 0 && Object.keys(answers).length === items.length ? answers : null;
}

/** One explicit submission answers every question; a 30s idle timeout picks the recommended option. */
function QuestionCard({ question, onAnswered, autoPickMs = AUTO_PICK_MS }: {
  question: ChatQuestion; onAnswered: () => void; autoPickMs?: number;
}) {
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now);
  const [autoAt, setAutoAt] = useState(() => Date.now() + autoPickMs);
  const [autoPicked, setAutoPicked] = useState(false);
  const autoTried = useRef(false);
  const fieldId = useId();
  const items = useMemo(() => question.questions || [], [question.questions]);
  const expires = typeof question.expiresAtMs === 'number' && Number.isFinite(question.expiresAtMs)
    && question.expiresAtMs > 0 ? question.expiresAtMs : undefined;
  const remaining = expires === undefined ? undefined : Math.max(0, Math.ceil((expires - now) / 1000));
  const expired = remaining === 0;
  const autoRemaining = Math.max(0, Math.ceil((autoAt - now) / 1000));

  useEffect(() => {
    // 无条件计时：自动选择也要靠这个时钟推进，不只是到期倒计时。
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 1000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  const ready = resolveAnswers(items, selected, custom, false);
  const allAnswered = ready !== null;
  const answeredCount = items.filter(item => {
    const text = (custom[item.questionId] || '').trim();
    return Boolean(text) || (selected[item.questionId] || []).length > 0;
  }).length;

  /** 用户一动就把 30s 窗口顺延，避免正打字时被自动提交。 */
  const touch = () => {
    if (autoTried.current) return;
    setAutoAt(Date.now() + AUTO_PICK_MS);
  };

  const pick = (item: ChatQuestionItem, label: string) => {
    if (busy || expired) return;
    touch();
    setSelected(previous => {
      const values = previous[item.questionId] || [];
      return { ...previous, [item.questionId]: item.multiSelect
        ? values.includes(label) ? values.filter(value => value !== label) : [...values, label]
        : [label] };
    });
    if (!item.multiSelect) setCustom(previous => ({ ...previous, [item.questionId]: '' }));
  };

  const submitWith = async (finalAnswers: Record<string, string[]>, auto = false): Promise<boolean> => {
    if (submitting.current) return false;
    // Recheck wall time even if the tab was throttled before the next timer tick.
    if (expires !== undefined && Date.now() >= expires) { setNow(Date.now()); return false; }
    submitting.current = true;
    setBusy(true); setError('');
    try {
      const result = await answerQuestion({
        questionId: question.id,
        answers: finalAnswers,
        ...(auto ? { resolvedBy: AUTO_RESOLVED_BY } : {}),
      });
      if (!result.ok) { setError(result.error || '提交失败，请重试'); return false; }
      onAnswered();
      return true;
    } catch {
      setError('回复未能提交，已保留填写内容，请重试。');
      return false;
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const submit = () => {
    if (ready) void submitWith(ready);
  };

  // 30s 无操作 → 自动选推荐项并提交，避免对话一直挂着等回复。
  useEffect(() => {
    if (autoTried.current || busy || expired) return;
    if (now < autoAt) return;
    const auto = resolveAnswers(items, selected, custom, true);
    if (!auto) return;  // 既没选项也没填写：只能继续等用户
    autoTried.current = true;
    setAutoPicked(true);
    void submitWith(auto, true);
    // submitWith 每次渲染都是新引用，故意不列入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, autoAt, busy, expired, items, selected, custom]);

  const statusText = expired
    ? autoPicked ? '已到期，已按推荐项自动提交' : '本次提问已到期'
    : busy
      ? autoPicked ? '正在自动提交推荐选项' : '正在提交回复'
      : autoPicked ? '已超时，按推荐项自动提交' : '等待你的回复';

  return (
    <div className="message-row assistant">
      <div className="msg-col assistant question-card__column">
        <form className="question-card" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <div className="question-card__status">
            <span>{statusText}</span>
            {remaining !== undefined && <span className={`question-card__timer${remaining <= 60 ? ' question-card__timer--urgent' : ''}`}
              role="timer" aria-live="off" aria-label={expired ? '回复时间已到期' : `回复剩余 ${formatRemaining(remaining)}`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
              {expired ? '已到期' : `剩余 ${formatRemaining(remaining)}`}
            </span>}
          </div>
          {!expired && !autoPicked && autoRemaining > 0 && (
            <div className="question-card__auto" role="note">
              {autoRemaining <= 10 ? `${autoRemaining} 秒后` : '若一直不选，'}将自动选择推荐项并提交
            </div>
          )}
          {items.map((item, index) => {
            const options = item.options || [];
            const values = selected[item.questionId] || [];
            const recommended = recommendedLabel(item);
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
                      {option.label === recommended && <em className="question-card__recommended">推荐</em>}
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
                      touch();
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
            <span className="question-card__hint">{expired
              ? autoPicked ? '已按推荐项自动提交，可在对话中继续补充。'
                : '未自动提交；填写内容已保留，可复制后在对话中继续回复。'
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
export default function QuestionCards({ questions, onDone, autoPickMs = AUTO_PICK_MS }: {
  questions: ChatQuestion[]; onDone?: (questionId: string) => void; autoPickMs?: number;
}) {
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const visible = useMemo(() => questions.filter(question => !answered[question.id]), [questions, answered]);
  const pending = visible.length;

  // 有未答问题就改写标签页标题：用户在别的 tab 也能看到「还有问题待回复」。
  useEffect(() => {
    if (pending <= 0) return;
    const base = document.title.replace(/^●\s*\d+\s*个问题待回复\s*·\s*/, '');
    document.title = `${TAB_NOTICE_PREFIX}${pending} 个问题待回复 · ${base}`;
    return () => { document.title = base; };
  }, [pending]);

  if (!pending) return null;
  return <>{visible.map(question => (
    <QuestionCard key={question.id} question={question} autoPickMs={autoPickMs} onAnswered={() => {
      setAnswered(previous => ({ ...previous, [question.id]: true }));
      onDone?.(question.id);
    }} />
  ))}</>;
}

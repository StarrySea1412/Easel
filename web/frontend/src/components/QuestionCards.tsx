import { useMemo, useState } from 'react';
import type { ChatQuestion, ChatQuestionItem } from '../lib/api';
import { answerQuestion } from '../lib/api';

/**
 * ask_user 问答题卡片。
 *
 * OpenClaw 的 ask_user 一次可带 1-3 个问题（question.questions[]）。gateway 的
 * question.resolve 要求 answers 里**每个问题都有答案**（单个缺失即报
 * QUESTION_INVALID_ANSWER: "question 'xxx' requires an answer"）。
 * 因此多问题时逐题推进，保留已选答案，最后一步统一提交一次。
 *
 * 多选：问题对象带 multiSelect: true 时，answers[qid] 可携带多个 label
 * （gateway 对 multiSelect=false 的多值直接报 "does not allow multiple answers"，
 * 前端只按数据渲染，不绕过校验）。
 */
function QuestionCard({ question, onAnswered }: { question: ChatQuestion; onAnswered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [customVals, setCustomVals] = useState<Record<string, string[]>>({});
  const [questionIndex, setQuestionIndex] = useState(0);

  const items: ChatQuestionItem[] = question.questions || [];
  const current = items[questionIndex];
  const valuesOf = (it: ChatQuestionItem): string[] => {
    const draft = (custom[it.questionId] || '').trim();
    if (!it.multiSelect) return draft ? [draft] : selected[it.questionId] || [];
    return [...new Set([...(selected[it.questionId] || []), ...(customVals[it.questionId] || []), ...(draft ? [draft] : [])])];
  };
  const allAnswered = items.length > 0 && items.every((it) => valuesOf(it).length > 0);
  const currentAnswered = current ? valuesOf(current).length > 0 : false;
  const isLastQuestion = questionIndex === items.length - 1;

  const pick = (it: ChatQuestionItem, label: string) => {
    setSelected((s) => {
      const cur = s[it.questionId] || [];
      const next = it.multiSelect
        ? (cur.includes(label) ? cur.filter((v) => v !== label) : [...cur, label])
        : [label];
      return { ...s, [it.questionId]: next };
    });
    if (!it.multiSelect) setCustom((c) => ({ ...c, [it.questionId]: '' }));
  };

  const addCustom = (it: ChatQuestionItem) => {
    const v = (custom[it.questionId] || '').trim();
    if (!v) return;
    setCustomVals((c) => ({ ...c, [it.questionId]: [...new Set([...(c[it.questionId] || []), v])] }));
    setCustom((c) => ({ ...c, [it.questionId]: '' }));
  };

  const removeCustom = (it: ChatQuestionItem, v: string) => {
    setSelected((s) => ({ ...s, [it.questionId]: (s[it.questionId] || []).filter((x) => x !== v) }));
    setCustomVals((c) => ({ ...c, [it.questionId]: (c[it.questionId] || []).filter((x) => x !== v) }));
  };

  const submit = async () => {
    if (busy || !allAnswered) return;
    setBusy(true); setError('');
    const answers: Record<string, string[]> = {};
    for (const it of items) answers[it.questionId] = valuesOf(it);
    try {
      const res = await answerQuestion({ questionId: question.id, answers });
      if (!res.ok) setError(res.error || '提交失败');
      else onAnswered();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const advance = () => {
    if (busy || !currentAnswered) return;
    if (isLastQuestion) void submit();
    else setQuestionIndex((index) => Math.min(index + 1, items.length - 1));
  };

  return (
    <section className="question-card" aria-label="Agent 等待你的回答">
      {current && (() => {
        const it = current;
        const options = it.options || [];
        const vals = valuesOf(it);
        const cvals = customVals[it.questionId] || [];
        return <div className="question-card__item" key={it.questionId}>
          <div className="question-card__topline">
            <span className="question-card__eyebrow">{it.header || '需要你选择'}</span>
            {items.length > 1 && <span className="question-card__count">{questionIndex + 1} / {items.length}</span>}
          </div>
          <h3 className="question-card__title">{it.question || '请选择'}
            {it.multiSelect && <span className="question-card__multi">可多选</span>}
          </h3>
          {options.length > 0 && <div className="question-card__options" role={it.multiSelect ? 'group' : 'radiogroup'} aria-label={it.question || '回答选项'}>
            {options.map((opt, idx) => {
              const isSelected = vals.includes(opt.label);
              const optionTabIndex = it.multiSelect ? undefined : isSelected || (!selected[it.questionId]?.length && idx === 0) ? 0 : -1;
              return <button key={opt.label} type="button"
                className={`question-card__option${isSelected ? ' question-card__option--selected' : ''}`}
                role={it.multiSelect ? 'checkbox' : 'radio'} aria-checked={isSelected} tabIndex={optionTabIndex}
                disabled={busy} onClick={() => pick(it, opt.label)}
                onKeyDown={(event) => {
                  if (it.multiSelect || !['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) return;
                  const buttons = [...(event.currentTarget.closest('.question-card__options')?.querySelectorAll<HTMLButtonElement>('[role="radio"]') || [])];
                  const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
                  const target = buttons[(idx + direction + buttons.length) % buttons.length];
                  if (!target) return;
                  event.preventDefault();
                  target.focus();
                  const targetIndex = buttons.indexOf(target);
                  const targetOption = options[targetIndex];
                  if (targetOption) pick(it, targetOption.label);
                }}>
                <span className={`question-card__marker${it.multiSelect ? ' is-check' : ''}`} aria-hidden="true">
                  {isSelected ? <svg viewBox="0 0 16 16"><path d="m3.5 8 3 3 6-6"/></svg> : !it.multiSelect && options.length > 1 ? idx + 1 : null}
                </span>
                <span className="question-card__option-copy">
                  <strong>{opt.label}</strong>
                  {opt.description && <small>{opt.description}</small>}
                </span>
              </button>;
            })}
          </div>}
          {it.multiSelect && cvals.length > 0 && <div className="question-card__custom-values" aria-label="自定义答案">
            {cvals.map((value) => <button type="button" key={value} disabled={busy} onClick={() => removeCustom(it, value)} title="移除自定义答案">{value}<span aria-hidden="true">×</span></button>)}
          </div>}
          <div className="question-card__response">
            <label htmlFor={`question-answer-${question.id}-${it.questionId}`}>{it.multiSelect ? '其他答案' : '或者写下你的回答'}</label>
            <div className="question-card__input-row">
              <input id={`question-answer-${question.id}-${it.questionId}`} type="text" value={custom[it.questionId] || ''}
                placeholder={it.multiSelect ? '输入其他选项' : '输入你的回答'} disabled={busy}
                onChange={(e) => {
                  setCustom((c) => ({ ...c, [it.questionId]: e.target.value }));
                  if (!it.multiSelect) setSelected((s) => ({ ...s, [it.questionId]: [] }));
                }}
                onKeyDown={(e) => { if (it.multiSelect && e.key === 'Enter' && (custom[it.questionId] || '').trim()) { e.preventDefault(); addCustom(it); } }} />
              {it.multiSelect && <button type="button" disabled={busy || !(custom[it.questionId] || '').trim()} onClick={() => addCustom(it)}>添加</button>}
            </div>
          </div>
          {error && <p className="question-card__error" role="alert">{error}</p>}
          <footer className="question-card__actions">
            {questionIndex > 0 ? <button type="button" className="question-card__back" disabled={busy} onClick={() => setQuestionIndex((index) => Math.max(0, index - 1))}>上一步</button> : <span className="question-card__hint">{it.multiSelect ? '可选择多个选项' : '选择一个选项即可继续'}</span>}
            <button type="button" className="question-card__submit" disabled={busy || !currentAnswered || (isLastQuestion && !allAnswered)} onClick={advance}>
              {busy ? '正在提交…' : isLastQuestion ? '提交回答' : '继续'}
              {!busy && !isLastQuestion && <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>}
            </button>
          </footer>
        </div>;
      })()}
      {busy && <span className="question-card__sr-status" role="status">正在提交回答</span>}
    </section>
  );
}

/** 流式中的 ask_user 问答题列表（一次性卡片，答完即从当前流移除）。 */
export default function QuestionCards({ questions, onDone }: { questions: ChatQuestion[]; onDone?: (questionId: string) => void }) {
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const visible = useMemo(
    () => questions.filter((q) => !answered[q.id]),
    [questions, answered],
  );
  if (!visible.length) return null;
  return (
    <>
      {visible.map((q) => (
        <QuestionCard key={q.id} question={q} onAnswered={() => {
          setAnswered((a) => ({ ...a, [q.id]: true }));
          onDone?.(q.id);   // 通知 App：此题已答，重放/恢复不再出现
        }} />
      ))}
    </>
  );
}

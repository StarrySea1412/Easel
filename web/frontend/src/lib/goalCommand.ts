export type GoalLifecycleAction = 'pause' | 'resume' | 'clear';
export type ComposerCommand =
  | { kind: 'set'; text: string }
  | { kind: 'view' }
  | { kind: 'lifecycle'; action: GoalLifecycleAction }
  | { kind: 'schedule'; text: string };

const LIFECYCLE: Record<string, GoalLifecycleAction> = {
  pause: 'pause', '暂停': 'pause',
  resume: 'resume', '继续': 'resume', '恢复': 'resume',
  clear: 'clear', '清除': 'clear', '取消': 'clear',
};
const VIEW_WORDS = new Set(['view', 'status', '查看', '状态']);

/** Codex-style command surface: /goal (view), /goal pause|resume|clear, /定时. */
export function parseComposerCommand(text: string): ComposerCommand | null {
  const raw = text.trim();
  const goal = raw.match(/^\/(?:goal|目标)(?:\s+([\s\S]*))?$/i);
  if (goal) {
    const arg = (goal[1] || '').trim();
    if (!arg) return { kind: 'view' };
    const lower = arg.toLowerCase();
    const action = LIFECYCLE[lower];
    if (action) return { kind: 'lifecycle', action };
    if (VIEW_WORDS.has(lower)) return { kind: 'view' };
    return { kind: 'set', text: arg };
  }
  const schedule = raw.match(/^\/(?:schedule|定时|计划)(?:\s+([\s\S]*))?$/i);
  if (schedule) return { kind: 'schedule', text: (schedule[1] || '').trim() };
  return null;
}

/** Objective text of a `/goal <text>` command; kept for seed callers. */
export function goalCommand(text: string): string | null {
  const parsed = parseComposerCommand(text);
  return parsed && parsed.kind === 'set' ? parsed.text : null;
}

const COMMAND_PREFIXES = ['g', 'go', 'goa', 'goal', 'side', 'btw', '/side', 's', 'sc', 'sch', 'sche', 'sched', 'schedul', 'schedule',
  '目', '目标', '定', '定时', '计', '计划'];

export function suggestsCommand(text: string): boolean {
  const raw = text.trim();
  if (raw === '/') return true;
  if (!raw.startsWith('/')) return false;
  return COMMAND_PREFIXES.includes(raw.slice(1).toLowerCase());
}

import type {TaskGoal, TaskRun} from './tasks';

export type TaskBucket = 'attention' | 'active' | 'history';
export const taskBuckets: Record<TaskBucket, string> = {attention:'需要处理', active:'进行中', history:'历史记录'};

export function taskBucket(goal: TaskGoal, runs: TaskRun[]): TaskBucket {
  const own = runs.filter(run => run.goalId === goal.id);
  if (own.some(run => run.state === 'unconfirmed')) return 'attention';
  if (['completed','cancelled'].includes(goal.status)) return own.some(run => ['running','queued'].includes(run.state)) ? 'attention' : 'history';
  if (goal.status === 'active' && !['waiting_input','review'].includes(goal.phase)) return 'active';
  return 'attention';
}

export function taskWorkspaceHash(goalId?: string): string {
  return '#/tasks' + (goalId && /^[A-Za-z0-9_.-]{1,120}$/.test(goalId) ? `/${goalId}` : '');
}

export function parseTaskWorkspaceHash(hash: string): {goalId?: string} | null {
  const match = /^#\/tasks(?:\/([A-Za-z0-9_.-]{1,120}))?\/?$/.exec(hash);
  return match ? {goalId:match[1]} : null;
}

export function isScheduleWorkspaceHash(hash: string): boolean {
  return /^#\/schedules\/?$/.test(hash);
}

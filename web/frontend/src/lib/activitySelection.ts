export type ActivityFilter = 'all' | 'running' | 'archived';

export interface ActivityTarget {
  sessionId: string;
  turnId: string;
}

interface ActivitySession {
  id: string;
  title: string;
  archived?: boolean;
}

interface ActivitySelectionOptions {
  search: string;
  filter: ActivityFilter;
  selectedId: string;
  activeSessionId: string | null;
  target?: ActivityTarget;
}

export function selectActivitySessions<T extends ActivitySession>(
  sessions: readonly T[],
  streams: Readonly<Record<string, unknown>>,
  { search, filter, selectedId, activeSessionId, target }: ActivitySelectionOptions,
) {
  const query = search.trim().toLowerCase();
  const visible = sessions.filter((session) => (
    session.title.toLowerCase().includes(query)
    && (filter === 'all'
      || (filter === 'running' && Boolean(streams[session.id]))
      || (filter === 'archived' && session.archived))
  ));

  // A vanished deep-link target must not silently show another session's
  // evidence. Selecting another row explicitly leaves this unavailable state.
  const missingTarget = Boolean(target && selectedId === target.sessionId
    && !sessions.some((session) => session.id === target.sessionId));

  // Keep selectedId as the user's preference even while a filter hides it.
  // Derive the displayed fallback strictly from matching rows so clearing a
  // filter can restore the preference without displaying hidden evidence.
  const session = missingTarget ? undefined : (
    visible.find((item) => item.id === selectedId)
    || visible.find((item) => item.id === activeSessionId)
    || visible[0]
  );

  return {
    visible,
    session,
    missingTarget,
    targetTurnId: target && session?.id === target.sessionId ? target.turnId : undefined,
  };
}

import { useLayoutEffect, useRef } from 'react';
import { registerCreationSlot, type CreationTool } from '../lib/creationWorkspace';

export default function CreationWorkspaceSlot({ kind, sessionId, compact = false, active = true }: { kind: CreationTool; sessionId: string | null; compact?: boolean; active?: boolean }) {
  const attach = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!active || !attach.current) return;
    const node = attach.current;
    return registerCreationSlot(kind, sessionId, node);
  }, [kind, sessionId, active]);
  return <div ref={attach} className={'creation-workspace-slot' + (compact ? ' is-compact' : '')} data-workspace-kind={kind} />;
}

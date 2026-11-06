import { IconPlay } from './icons';

export default function ChatContinuationControls({busy, canContinue, onContinue}: {
  busy: boolean; canContinue: boolean; onContinue: () => void;
}) {
  if (!canContinue) return null;
  return <button type="button" className="chat-continuation-action" aria-label="继续未完成任务" title="继续未完成任务" disabled={busy} onClick={onContinue}><IconPlay size={16}/></button>;
}

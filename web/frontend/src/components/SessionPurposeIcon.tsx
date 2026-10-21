import type { ChatSession } from '../lib/store';
import { sessionPurpose } from '../lib/sessionPurpose';
import { IconChart, IconEdit, IconChat } from './icons';

export default function SessionPurposeIcon({ session }: { session: ChatSession }) {
  const purpose = sessionPurpose(session);
  const Icon = purpose.kind === 'analysis' ? IconChart : purpose.kind === 'generation' ? IconEdit : IconChat;
  return <span className={`session-purpose-icon is-${purpose.kind}`} data-purpose={purpose.kind} role="img" aria-label={purpose.detail} title={purpose.detail}><Icon size={15}/></span>;
}

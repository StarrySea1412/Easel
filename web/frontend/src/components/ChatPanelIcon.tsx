import { IconChat, IconCompass, IconEdit, IconFolder, IconLayout, IconTarget, IconTerminal } from './icons';
import BrowserSiteIcon from './BrowserSiteIcon';

/** Panel identity is available before any page or tool data loads. */
export default function ChatPanelIcon({ kind, size = 14, source }: { kind: string; size?: number; source?: string }) {
  const icons: Record<string, typeof IconChat> = { browser: IconCompass, files: IconFolder, terminal: IconTerminal,
    changes: IconEdit, side: IconChat, goal: IconTarget };
  const Icon = icons[kind] || IconLayout;
  return <span className="chat-panel-tab-icon" aria-hidden="true">{kind==='browser'?<BrowserSiteIcon source={source}/>:<Icon size={size}/>}</span>;
}

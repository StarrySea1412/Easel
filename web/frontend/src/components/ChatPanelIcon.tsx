import { IconChat, IconCompass, IconEdit, IconFolder, IconLayout, IconTarget, IconTerminal, IconSources } from './icons';
import BrowserSiteIcon from './BrowserSiteIcon';
import { IconImage } from './settingsIcons';
import { IconPublish } from './icons';

/** Panel identity is available before any page or tool data loads. */
export default function ChatPanelIcon({ kind, size = 14, source }: { kind: string; size?: number; source?: string }) {
  const icons: Record<string, typeof IconChat> = { browser: IconCompass, files: IconFolder, terminal: IconTerminal,
    analysis: IconLayout, changes: IconEdit, side: IconChat, goal: IconTarget, sources: IconSources, image: IconImage, publish: IconPublish };
  const Icon = icons[kind] || IconLayout;
  return <span className="chat-panel-tab-icon" aria-hidden="true">{kind==='browser'?<BrowserSiteIcon source={source}/>:<Icon size={size}/>}</span>;
}

import { useEffect, useId, useRef, useState } from 'react';
import type { ChatTurnNode } from '../lib/chatNavigation';

interface ChatTurnNavigationProps {
  nodes: ChatTurnNode[];
  current: number;
  following: boolean;
  onJump: (index: number) => void;
  onLatest: () => void;
}

export default function ChatTurnNavigation({ nodes, current, following, onJump, onLatest }: ChatTurnNavigationProps) {
  const [expanded, setExpanded] = useState(false);
  const navigation = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!expanded) return;
    list.current?.querySelector<HTMLButtonElement>('button[aria-current]')?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent | KeyboardEvent) => {
      if (event.type === 'keydown') {
        if ((event as KeyboardEvent).key !== 'Escape') return;
        event.preventDefault();
      } else if (navigation.current?.contains(event.target as Node)) return;
      // Pointer defaults can still focus the clicked input/button. Restore focus
      // only when dismissing would otherwise leave it inside the removed panel.
      if (navigation.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
      setExpanded(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
  }, [expanded]);

  useEffect(() => {
    const container = list.current;
    const button = container?.querySelector<HTMLButtonElement>('button[aria-current]');
    if (!container || !button) return;
    const top = button.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (top + button.offsetHeight > container.scrollTop + container.clientHeight) {
      container.scrollTop = top + button.offsetHeight - container.clientHeight;
    }
  }, [current, expanded]);

  const choose = (action: () => void) => {
    action();
    // A jump may focus the destination in the message stream. Preserve that;
    // otherwise return to the compact trigger when removing the focused item.
    if (navigation.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
    setExpanded(false);
  };

  return (
    <nav ref={navigation} className="chat-turn-navigation" aria-label="对话轮次导航">
      <button ref={trigger} type="button" className="chat-turn-nav-trigger" aria-expanded={expanded}
        aria-controls={panelId} aria-label={`对话轮次目录，当前第 ${current + 1} 轮，共 ${nodes.length} 轮`}
        onClick={() => setExpanded(value => !value)}>
        <span>轮次</span><span className="chat-turn-nav-count">{current + 1} / {nodes.length}</span>
        <span className={`chat-turn-nav-chevron${expanded ? ' is-open' : ''}`} aria-hidden="true">⌄</span>
      </button>
      {expanded && <div id={panelId} className="chat-turn-popover">
        <div className="chat-turn-nav-title"><span>对话目录</span><small>{following ? '跟随最新' : '正在浏览历史'}</small></div>
        <div className="chat-turn-nav-controls">
          <button type="button" disabled={current <= 0} aria-label="跳转上一轮对话" title="上一轮" onClick={() => choose(() => onJump(current - 1))}>↑ 上一轮</button>
          <button type="button" disabled={current >= nodes.length - 1} aria-label="跳转下一轮对话" title="下一轮" onClick={() => choose(() => onJump(current + 1))}>↓ 下一轮</button>
          <button type="button" className={following ? 'following' : ''} onClick={() => choose(onLatest)} aria-label="回到底部并跟随最新回复" title="回到底部并跟随回复">最新 ↓</button>
        </div>
        <ol className="chat-turn-node-list" ref={list}>
          {nodes.map((node, index) => <li key={node.messageIndex}>
            <button type="button" aria-current={index === current ? 'step' : undefined}
              title={`第 ${node.number} 轮：${node.label}`} onClick={() => choose(() => onJump(index))}
              onKeyDown={event => {
                let next: number | undefined;
                if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
                if (event.key === 'ArrowDown') next = Math.min(nodes.length - 1, index + 1);
                if (event.key === 'Home') next = 0;
                if (event.key === 'End') next = nodes.length - 1;
                if (next !== undefined) {
                  event.preventDefault();
                  onJump(next);
                  list.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus({ preventScroll: true });
                }
              }}>
              <span className="chat-turn-node-number">{node.number}</span>
              <span className="chat-turn-node-label">{node.label}</span>
            </button>
          </li>)}
        </ol>
      </div>}
    </nav>
  );
}

import { useState } from 'react';
import { useChatSources } from '../hooks/useChatSources';
import type { ChatSession } from '../lib/store';
import { IconCompass, IconFile, IconSearch, IconSources, IconRefresh } from './icons';
import '../styles/chat-sources.css';

export default function ChatSourcesPanel({ session, active, onLocate }: { session: ChatSession; active: boolean; onLocate: (turnId: string) => void }) {
  const [query, setQuery] = useState('');
  const sources = useChatSources(session, active);
  const term = query.trim().toLocaleLowerCase();
  const matches = (...values: string[]) => values.join(' ').toLocaleLowerCase().includes(term);
  let turnNumber = 0;
  const turnNumbers = new Map<string, number>();
  for (const message of session.messages) {
    if (message.role === 'user') turnNumber++;
    if (message.turnId) turnNumbers.set(message.turnId, Math.max(1, turnNumber));
  }
  if (session.pendingTurnId) turnNumbers.set(session.pendingTurnId, Math.max(1, turnNumber));
  const pages = sources.pages.filter(page => matches(page.title, page.url, ...page.evidence.map(item => item.query || '')));
  const tools = sources.tools.filter(tool => matches(tool.name));
  const attachments = session.messages.flatMap((message, index) => (message.attachments || []).map(file => ({ ...file, index, turnId: message.turnId })))
    .filter((file, index, all) => all.findIndex(other => other.id === file.id) === index).filter(file => matches(file.name));
  return <section className="chat-sources-panel" aria-label="来源面板">
    <header className="chat-panel-tool-heading"><h2><IconSources size={17}/>来源</h2><span>{sources.pages.length} 个网页</span><button type="button" className="source-refresh" aria-label="刷新来源" onClick={sources.refresh} disabled={sources.loading}><IconRefresh size={15}/></button></header>
    <p className="chat-panel-scope">当前对话实际检索返回、网页读取与浏览器观察的来源。</p>
    <label className="source-search"><IconSearch size={15}/><input type="search" aria-label="搜索当前对话来源" placeholder="搜索标题、网址或检索词" value={query} onChange={event => setQuery(event.target.value)}/></label>
    <p className="source-window" role="status">{sources.loading ? '正在读取来源…' : session.importedFromBackup ? '备份中的附件；不读取当前服务记录' : `来源范围：最近 ${sources.loadedTurns} / ${sources.totalTurns} 轮记录`}</p>
    {sources.error && <p className="chat-panel-error" role="alert">{sources.error}<button type="button" onClick={sources.refresh} disabled={sources.loading}>重试</button></p>}
    {pages.length > 0 && <div className="source-section"><h3>网页 <span>{pages.length}</span></h3>{pages.map(page => <article className="source-page" key={page.url}>
      <span className="source-item-icon" aria-hidden="true"><IconCompass size={18}/></span><div className="source-item-body"><a href={page.url} target="_blank" rel="noopener noreferrer" className="source-page-title">{page.title || new URL(page.url).hostname}<span aria-hidden="true"> ↗</span></a><span className="source-page-url" title={page.url}>{page.url}</span>
        <div className="source-evidence">{page.evidence.map(item => <span key={item.id} title={item.query}>{item.label}{['failed', 'denied', 'stopped'].includes(item.status) ? ' · 未成功' : item.status === 'running' ? ' · 执行中' : item.status === 'unconfirmed' ? ' · 结果待确认' : ''}{item.turnId && <button type="button" onClick={() => onLocate(item.turnId!)}>第 {turnNumbers.get(item.turnId) || '—'} 轮对话</button>}</span>)}</div>
      </div></article>)}</div>}
    {attachments.length > 0 && <div className="source-section"><h3>对话附件 <span>{attachments.length}</span></h3>{attachments.map(file => <article className="source-page" key={file.id}><span className="source-item-icon" aria-hidden="true"><IconFile size={18}/></span><div className="source-item-body"><strong>{file.name}</strong><small>已附加到对话{file.turnId && <button type="button" onClick={() => onLocate(file.turnId!)}>查看对话</button>}</small></div></article>)}</div>}
    {!pages.length && !attachments.length && !sources.loading && <div className="source-empty"><IconSources size={26}/><h3>{term ? '没有匹配的网页或附件' : '还没有记录网页来源'}</h3><p>{term ? '试试其他标题、域名或检索词。' : 'Agent 检索或读取网页后会显示在这里。回答中普通提到的链接不会标成已检索来源。'}</p></div>}
    {sources.more && <button type="button" className="source-load-more" onClick={sources.loadMore} disabled={sources.loading}>查看更早 10 轮来源</button>}
    {tools.length > 0 && <details className="source-tools"><summary>使用过的工具 · {sources.tools.reduce((count, tool) => count + tool.calls, 0)} 次调用</summary>{tools.map(tool => <div key={tool.name}><IconSources size={15}/><span>{tool.name}</span><small>{tool.calls} 次{tool.failed ? ` · ${tool.failed} 次未成功` : ''}</small></div>)}</details>}
    <p className="source-footnote">检索返回不代表已经读完或引用；未提供链接的工具只显示调用记录。手动网页来源最多保留最近 200 次观察。</p>
  </section>;
}

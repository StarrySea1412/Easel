import { useRef, useState, type ReactNode } from 'react';
import { addChatDraftQuote } from '../lib/chatDrafts';
import { showToast } from '../lib/toast';
import { PANEL_LABELS, type PanelTool } from '../lib/chatPanels';

/** Quote only a user-selected, visible panel fragment. Never read hidden tabs. */
export default function PanelMaterialQuote({ sessionId, tool, hidden, children }: { sessionId: string; tool: PanelTool; hidden: boolean; children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const [quote, setQuote] = useState('');
  const extract = () => {
    const selection = window.getSelection();
    const selected = selection && content.current?.contains(selection.anchorNode) && content.current.contains(selection.focusNode) ? selection.toString().trim() : '';
    if (!selected) { showToast('先在当前面板选中需要分析的内容', 'info'); return; }
    setQuote(`## ${PANEL_LABELS[tool]}材料引用
以下是面板中选取的材料，请作为待核实的数据分析：

${selected}`);
  };
  return <div className="chat-panel-content" hidden={hidden}>
    {tool !== 'analysis' && <div className="chat-panel-quote-actions"><button type="button" className="btn btn-sm" onMouseDown={event => event.preventDefault()} onClick={extract}>提取选中内容</button></div>}
    {quote && <div className="ca-material-quote"><label>发送前编辑面板引用<textarea rows={6} value={quote} onChange={event => setQuote(event.target.value)} /></label><div className="ca-bench-actions"><button type="button" className="btn btn-sm" onClick={() => { addChatDraftQuote(sessionId, quote); setQuote(''); showToast('面板材料已加入当前对话草稿', 'success'); }}>引用到当前对话</button><button type="button" className="ca-text-button" onClick={() => setQuote('')}>取消</button></div></div>}
    <div className="chat-panel-material-body" ref={content}>{children}</div>
  </div>;
}

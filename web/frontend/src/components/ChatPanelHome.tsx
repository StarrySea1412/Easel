import { IconFile, IconFolder, IconCompass, IconTerminal, IconEdit, IconChat, IconTarget, IconChevron, IconSources } from './icons';
import type { ChatSession } from '../lib/store';
import type { ChatArtifact } from '../lib/chatArtifacts';
import type { PanelTool } from '../lib/chatPanels';

interface Props {
  onTool: (tool: PanelTool) => void;
  onSideChat: () => void;
  onGoal: () => void;
  hasGoal: boolean;
  artifacts: ChatArtifact[];
  onFile: (id: string) => void;
  closedSessions: ChatSession[];
  onReopen: (id: string) => void;
}
const tools = [
  { id: 'files', title: '文件', hint: '浏览对话文件与产物', Icon: IconFolder },
  { id: 'browser', title: '浏览器', hint: '浏览、操作与页面分析', Icon: IconCompass },
  { id: 'sources', title: '来源', hint: '查找检索过的网页与资料出处', Icon: IconSources },
  { id: 'terminal', title: '终端', hint: '查看命令与执行输出', Icon: IconTerminal },
  { id: 'changes', title: '变更', hint: '查看文件变更回执', Icon: IconEdit },
  { id: 'side', title: '辅助对话', hint: '独立讨论旁支问题', Icon: IconChat },
] as const;

export default function ChatPanelHome(props: Props) {
  return <section className="chat-panel-home" aria-label="新增面板">
    <h2>新增面板</h2><p className="chat-panel-home-intro">把需要的工具放在对话旁边。</p>
    <h3>工具</h3>
    <div className="chat-panel-tool-grid">
      {tools.map(({id,title,hint,Icon})=><button type="button" className="chat-panel-tool" key={id} onClick={()=>id==='side'?props.onSideChat():props.onTool(id)}>
        <span className="chat-panel-tool-icon" aria-hidden="true"><Icon size={20}/></span>
        <span className="chat-panel-tool-text"><strong>{title}</strong><small>{hint}</small></span><span className="chat-panel-tool-open">打开</span>
      </button>)}
    </div>
    <details className="chat-panel-more"><summary>更多工具 <IconChevron size={12}/></summary>
      <button type="button" className="chat-panel-tool" onClick={props.onGoal}><span className="chat-panel-tool-icon" aria-hidden="true"><IconTarget size={20}/></span><span className="chat-panel-tool-text"><strong>目标</strong><small>{props.hasGoal?'查看当前目标与真实进度':'设置一个持续目标'}</small></span><span className="chat-panel-tool-open">打开</span></button>
    </details>
    <div className="chat-panel-home-section"><h3>推荐</h3>
      {props.artifacts.length?<div className="chat-panel-recommendations">{props.artifacts.slice(-4).reverse().map(file=><button type="button" key={file.id} onClick={()=>props.onFile(file.id)}><span className="chat-panel-recommendation-icon" aria-hidden="true"><IconFile size={22}/></span><strong title={file.name}>{file.name}</strong><small>当前对话文件</small></button>)}</div>
        :<p className="chat-panel-home-empty">这段对话有文件产出后，会在这里推荐。你也可以先打开一个工具。</p>}
    </div>
    {props.closedSessions.length>0&&<div className="chat-panel-home-section"><h3>重新打开</h3><div className="chat-panel-reopen-list">{props.closedSessions.map(side=><button type="button" key={side.id} onClick={()=>props.onReopen(side.id)}><IconChat size={15}/><span>{side.title}</span><small>{side.pendingTurnId?'后台任务尚未结束':'历史和草稿已保留'}</small></button>)}</div></div>}
  </section>;
}

import { useId } from 'react';
import { createPortal } from 'react-dom';
import type { AnalysisBinding } from '../lib/analysisBinding';
import { useModalFocus } from '../hooks/useModalFocus';
import AnalysisEvidenceOverview from './AnalysisEvidenceOverview';
import OutputMessageContent from './OutputMessageContent';
import PlatformIcon from './PlatformIcon';
import { IconChart } from './icons';
import '../styles/analysis-visuals.css';

export default function AnalysisMaterialDialog({ context, onClose, onOpenPanel }: { context: AnalysisBinding; onClose: () => void; onOpenPanel?: () => void }) {
  const ref = useModalFocus(true, onClose), id = useId();
  return createPortal(<div className="overlay" onPointerDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div className="modal analysis-material-dialog" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} tabIndex={-1}>
      <header><div><h2 id={id}><IconChart size={19}/>分析材料</h2><p><PlatformIcon platform={context.platform} name={context.platform}/><span>{context.accountName}</span><span>{context.contentIds.length} 篇作品</span></p></div><button type="button" className="btn btn-sm" data-modal-autofocus aria-label="关闭分析材料" onClick={onClose}>×</button></header>
      <div className="analysis-material-dialog-body"><AnalysisEvidenceOverview context={context}/><details><summary>原始 Markdown / JSON 材料</summary><OutputMessageContent inert content={context.markdown}/></details></div>
      <footer>{onOpenPanel && <button type="button" className="btn btn-sm" onClick={()=>{onOpenPanel();onClose();}}><IconChart size={14}/>在辅助面板查看</button>}<button type="button" className="btn btn-primary btn-sm" onClick={onClose}>关闭</button></footer>
    </div>
  </div>, document.body);
}

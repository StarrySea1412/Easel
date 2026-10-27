import { useChatArtifacts } from '../../hooks/useChatArtifacts';
import type { OfficeAgent } from '../../lib/agentOffice';
import ChatArtifacts from '../ChatArtifacts';

/** Read only declared deliveries for this exact execution, never workspace guesses. */
export default function OfficeMemberFiles({ execution }: {execution:NonNullable<OfficeAgent['execution']>}) {
  const files=useChatArtifacts(execution.sessionId,true,false);
  const items=files.items.filter(item=>item.turnId===execution.turnId);
  return <section className="office-process-section" aria-label="成员交付文件"><h3>本轮交付</h3>
    {files.note&&<p role="status">{files.note}</p>}
    <ChatArtifacts artifacts={items} onUpdated={files.updated}/>
    {!items.length&&<p className="office-process-empty">尚未读取到本轮登记的交付文件。</p>}
  </section>;
}

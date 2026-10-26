import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { ChatSession } from '../lib/store';
import type { PublishReceiptsModel } from '../hooks/usePublishReceipts';
import { useImageStudio, type ImageStudioController } from '../hooks/useImageStudio';
import type { VideoStudioController } from '../hooks/useVideoStudio';
import { creationRevision, subscribeCreation, creationWorkspaces, creationSlot, selectCreation, ensureCreation, backupCreationDraft, previousCreationDraft, canReturnToSession, returnImageToChat, addImageToPublish, type CreationWorkspace } from '../lib/creationWorkspace';
import { useChatArtifacts } from '../hooks/useChatArtifacts';
import { artifactUrl } from '../lib/chatArtifacts';
import { mediaUrl } from '../lib/api';
import PublishSpinner from './PublishSpinner';
import ImageStudioPage from './ImageStudioPage';
import PublishPage from './PublishPage';
import Select from './ui/Select';
import { IconChat, IconImage, IconPublish, IconTarget, IconChevron, IconExpand, IconImport, IconHistory, IconPlus } from './icons';
import { getChatDraft } from '../lib/chatDrafts';
import { confirmModal } from './ui/ConfirmModal';
import { showToast } from '../lib/toast';
import { creationMaterial, consumeCreationMaterial, creationTarget, saveCreationTarget } from '../lib/creationWorkspace';
import '../styles/creation-workspace.css';

type Props = {
  studio: ImageStudioController; video: VideoStudioController; receipts: PublishReceiptsModel; sessions: ChatSession[]; persona: string;
  onOpenSettings: () => void; onOpenVideoSettings: () => void; onOpenOutputs: () => void; onOpenAccounts?: () => void; onOpenPublishOutputs?: () => void;
  onExpand: (kind:'image'|'publish') => void; onOpenChat: (sessionId: string) => void; onNewChat: () => string;
  onPromptSkill?: (skill: string, input: string) => boolean;
};
export default function CreationWorkspaceHost(props: Props) {
  useSyncExternalStore(subscribeCreation, creationRevision);
  ensureCreation('image', null);
  const valid = creationWorkspaces().filter(item => !item.sessionId || props.sessions.some(session => session.id === item.sessionId));
  return <>{valid.map(workspace => workspace.kind==='image' && workspace.sessionId
    ? <ChatImageWorkspace key={workspace.id} {...props} workspace={workspace}/>
    : <WorkspaceInstance key={workspace.id} {...props} workspace={workspace}/>)}</>;
}
function ChatImageWorkspace(props: Props & {workspace:CreationWorkspace}) {
  const studio=useImageStudio(Boolean(creationSlot(props.workspace.id)),props.workspace.id);
  return <WorkspaceInstance {...props} studio={studio}/>;
}
function WorkspaceInstance(props: Props & {workspace:CreationWorkspace}) {
  const {workspace, sessions, onExpand, onOpenChat, onNewChat} = props;
  const slot = creationSlot(workspace.id);
  const active = Boolean(slot);
  const deliveries = useChatArtifacts(workspace.sessionId || '', active && Boolean(workspace.sessionId) && workspace.kind === 'image', false);
  const studio = props.studio;
  const [container] = useState(() => document.createElement('div'));
  const [target, updateTarget] = useState<string | null>(() => creationTarget(workspace));
  const setTarget = (id: string) => { saveCreationTarget(workspace,id); updateTarget(id); };
  const [showTarget, setShowTarget] = useState(false);
  const targetId = target && sessions.some(session => session.id === target) && canReturnToSession(target) ? target : null;
  const [, changedBackup] = useState(0);
  useLayoutEffect(() => {
    if (slot) slot.appendChild(container);
    return () => { container.remove(); };
  }, [slot, container]);
  const sourceText = () => {
    if (!workspace.sessionId) return '';
    const staged = creationMaterial(workspace);
    if (staged) return staged;
    const selection = window.getSelection();
    const node = selection?.anchorNode?.parentElement?.closest('[data-creation-session]');
    const end = selection?.focusNode?.parentElement?.closest('[data-creation-session]');
    if (node && node === end && node.getAttribute('data-creation-session') === workspace.sessionId && selection?.toString().trim()) return selection.toString().trim();
    const draft = getChatDraft(workspace.sessionId);
    return [draft.text, ...(draft.quotes || [])].filter(Boolean).join('\n\n') || sessions.find(item => item.id === workspace.sessionId)?.messages.findLast(item => item.role === 'assistant' && !item.error)?.content || '';
  };
  const seedImage = async () => {
    const text = sourceText();
    if (!text.trim()) { showToast('先选择对话内容，或填写对话草稿', 'info'); return; }
    if (studio.imgPrompt.trim()) {
      if (!(await confirmModal('保存当前提示词后，用选中内容开始新的生图草稿？', {confirmLabel:'保存并新建'}))) return;
      backupCreationDraft(workspace,{prompt:studio.imgPrompt,size:studio.imgSize}); changedBackup(value => value + 1);
    }
    studio.setImgPrompt(text.slice(0,2000));
    consumeCreationMaterial(workspace);
  };
  const source = sessions.find(item => item.id === workspace.sessionId);
  const targetOptions = sessions.filter(item => !item.archived && !item.importedFromBackup && !item.parentSessionId).map(item => ({value:item.id,label:item.title || '新对话'}));
  const backup = previousCreationDraft(workspace) as {prompt?:unknown;size?:unknown} | null;
  const busy = studio.imgSubmitting || studio.imgJob?.state === 'running';
  useEffect(()=>{
    if (workspace.kind !== 'image' || busy || studio.imgPrompt.trim()) return;
    const material=creationMaterial(workspace);
    if(material) { studio.setImgPrompt(material.slice(0,2000)); consumeCreationMaterial(workspace); }
  },[workspace,active,busy,studio]);
  const targetLabel = targetId ? sessions.find(item=>item.id===targetId)?.title || '对话' : '选择目标对话';
  const toolbar = <div className="creation-workspace-toolbar" role="group" aria-label="创作工作区操作">
    <div className="creation-workspace-identity"><span className="creation-tool-icon">{workspace.kind === 'image' ? <IconImage size={17}/> : <IconPublish size={17}/>}</span><strong title={source?.title}>{source?.title || (workspace.kind === 'image' ? '生图工坊' : '发布中心')}</strong></div>
    <div className="creation-workspace-navigation">
      <button type="button" className="creation-target-button" title={'回填目标：'+targetLabel} aria-label={'回填目标：'+targetLabel} aria-expanded={showTarget} onClick={()=>setShowTarget(value=>!value)}><IconTarget size={15}/><span>{targetLabel}</span><IconChevron size={12}/></button>
      {targetId && <button type="button" className="creation-icon-button" title="回到对话" aria-label="回到对话" onClick={()=>onOpenChat(targetId)}><IconChat size={16}/></button>}
      <button type="button" className="creation-icon-button creation-expand" title="展开工作区" aria-label="展开工作区" onClick={()=>{selectCreation(workspace.kind,workspace.sessionId);onExpand(workspace.kind);}}><IconExpand size={16}/></button>
    </div>
    {workspace.kind === 'image' && source && <div className="creation-toolbar-actions"><button type="button" className="btn btn-sm" disabled={busy} onMouseDown={event=>event.preventDefault()} onClick={()=>void seedImage()}><IconImport size={14}/>带入对话内容</button>
    {typeof backup?.prompt === 'string' && <button type="button" className="btn btn-sm" disabled={busy} onClick={async()=>{if(await confirmModal('恢复上一份提示词？当前提示词将保留为可恢复版本。')) {backupCreationDraft(workspace,{prompt:studio.imgPrompt,size:studio.imgSize});studio.setImgPrompt(backup.prompt as string);changedBackup(value=>value+1);}}}><IconHistory size={14}/>恢复上一稿</button>}</div>}
    {showTarget && <div className="creation-target"><Select aria-label="回填目标对话" value={targetId || ''} options={targetOptions} onChange={setTarget}/><button type="button" className="btn btn-sm" onClick={()=>setTarget(onNewChat())}><IconPlus size={14}/>新建目标对话</button></div>}
  </div>;
  return createPortal(<div className="creation-workspace-mount">{toolbar}{workspace.kind === 'image' && (deliveries.jobs.length > 0 || deliveries.items.some(item=>item.mimeType.startsWith('image/'))) && <section className="creation-agent-jobs" aria-label="对话助手生图任务">
    <strong>对话中的图片任务</strong>
    {deliveries.jobs.map(job=><p key={job.jobId}>{['queued','running'].includes(job.phase)&&<PublishSpinner/>} {job.prompt.slice(0,80)} · {({queued:'排队中',running:'生成中',done:'已完成',error:'失败',unconfirmed:'结果待核实'})[job.phase]}{job.error&&<span role="alert"> · {job.error}</span>}</p>)}
    <div className="creation-agent-images">{deliveries.items.filter(item=>item.status==='ready'&&item.mimeType.startsWith('image/')).map(item=><article key={item.id}><a href={artifactUrl(item,'file')} target="_blank" rel="noreferrer"><img src={artifactUrl(item,'file')} alt={item.description || item.name}/></a>{targetId&&<button className="link-btn" onClick={async()=>{try{await returnImageToChat(targetId,mediaUrl(item.path));showToast('图片已加入目标对话','success');}catch(reason){showToast(reason instanceof Error?reason.message:'引用失败','error');}}}>添加到对话</button>}<button className="link-btn" onClick={()=>{try{addImageToPublish(workspace.sessionId,mediaUrl(item.path));onExpand('publish');}catch(reason){showToast(reason instanceof Error?reason.message:'添加失败','error');}}}>用于发布</button></article>)}</div>
    {deliveries.note && <p role="status">{deliveries.note}</p>}
  </section>}{workspace.kind === 'image'
    ? <ImageStudioPage active={active} onPromptSkill={props.onPromptSkill} studio={studio} video={workspace.sessionId ? undefined : props.video} sessionId={targetId} sourceSessionId={workspace.sessionId} onOpenPublish={()=>{selectCreation('publish',workspace.sessionId);onExpand('publish');}} onOpenSettings={props.onOpenSettings} onOpenVideoSettings={props.onOpenVideoSettings} onOpenModels={props.onOpenSettings} onOpenOutputs={props.onOpenOutputs}/>
    : <PublishPage workspaceId={workspace.id} sourceSessionId={workspace.sessionId} targetSessionId={targetId} getSourceText={sourceText} active={active} persona={source ? source.persona || '' : props.persona} publishReceipts={props.receipts} onOpenAccounts={props.onOpenAccounts} onOpenOutputs={props.onOpenPublishOutputs || props.onOpenOutputs}/>
  }</div>,container);
}

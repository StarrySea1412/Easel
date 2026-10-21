import type { PublishReceipt, UploadedFile } from './api';
import { uploadFiles } from './api';
import { addChatDraftQuote, appendChatDraftUploads, beginChatDraftUpload, finishChatDraftUpload, getChatDraft, clearChatDraft } from './chatDrafts';
import { loadPublishDraft, type PublishDraft } from './store';
import { readLocalValue, writeLocalValue } from './localPersistence';

export type CreationTool = 'image' | 'publish';
export type CreationWorkspace = { id: string; sessionId: string | null; kind: CreationTool };
const listeners = new Set<() => void>();
let revision = 0;
const workspaces = new Map<string, CreationWorkspace>();
const slots = new Map<string, HTMLElement>();
const focus: Record<CreationTool, string | null> = { image: null, publish: null };
const deleted = new Set<string>();
const returnedImages = new Map<string, UploadedFile[]>();
const transfers = new Map<string, Promise<UploadedFile[]>>();
const indexKey = 'easel:creation-workspaces:v1';
let hydrated = false;
const key = (id: string) => 'easel:creation-workspace:' + id;
const emit = () => { revision++; listeners.forEach(listener => listener()); };
export const subscribeCreation = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const creationRevision = () => revision;
const panelRequestKey = 'easel:creation-panel-request';
export function requestCreationPanel(kind: CreationTool, sessionId: string, text?: string) {
  selectCreation(kind, sessionId);
  writeLocalValue(panelRequestKey, JSON.stringify({kind, sessionId}));
  if (text?.trim()) writeLocalValue(key(kind + ':' + sessionId) + ':material', text.trim());
  emit();
  window.dispatchEvent(new window.Event('easel:open-creation-panel'));
}
export function takeCreationPanel(sessionId: string): CreationTool | null {
  try {
    const request = JSON.parse(readLocalValue(panelRequestKey).value || 'null');
    if (request?.sessionId !== sessionId || !canReturnToSession(sessionId) || !['image','publish'].includes(request.kind)) return null;
    writeLocalValue(panelRequestKey, 'null');
    return request.kind;
  } catch { return null; }
}
export function creationMaterial(workspace: CreationWorkspace) { return readLocalValue(key(workspace.id) + ':material').value || ''; }
export function consumeCreationMaterial(workspace: CreationWorkspace) { const text=creationMaterial(workspace); writeLocalValue(key(workspace.id)+':material',''); return text; }
export function creationTarget(workspace: CreationWorkspace) {
  const value = readLocalValue(key(workspace.id) + ':target').value;
  return value && canReturnToSession(value) ? value : workspace.sessionId;
}
export function saveCreationTarget(workspace: CreationWorkspace, sessionId: string) {
  if (!canReturnToSession(sessionId)) throw new Error('目标对话已删除');
  writeLocalValue(key(workspace.id) + ':target', sessionId);
}
function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const value = JSON.parse(readLocalValue(indexKey).value || '{}');
    for (const id of Array.isArray(value.deleted) ? value.deleted : []) if (typeof id === 'string') deleted.add(id);
    for (const item of Array.isArray(value.workspaces) ? value.workspaces : []) {
      if (!item || !['image','publish'].includes(item.kind) || !(item.sessionId === null || typeof item.sessionId === 'string') || deleted.has(item.sessionId)) continue;
      const id = item.kind + ':' + (item.sessionId || 'standalone');
      workspaces.set(id, {id, kind:item.kind, sessionId:item.sessionId});
    }
    for (const kind of ['image','publish'] as const) if (workspaces.get(value.focus?.[kind])?.kind === kind) focus[kind] = value.focus[kind];
  } catch { /* Invalid optional index cannot grant access to data. */ }
}
function persist() { writeLocalValue(indexKey, JSON.stringify({workspaces:[...workspaces.values()], focus, deleted:[...deleted]})); }
export const creationWorkspaces = () => { hydrate(); return [...workspaces.values()].filter(item => !item.sessionId || !deleted.has(item.sessionId)); };
export function ensureCreation(kind: CreationTool, sessionId: string | null): CreationWorkspace {
  hydrate();
  const id = kind + ':' + (sessionId || 'standalone');
  let workspace = workspaces.get(id);
  if (!workspace) { workspace = { id, sessionId, kind }; workspaces.set(id, workspace); persist(); }
  return workspace;
}
export function selectCreation(kind: CreationTool, sessionId: string | null) {
  hydrate();
  if (sessionId && deleted.has(sessionId)) throw new Error('来源对话已删除');
  const workspace = ensureCreation(kind, sessionId);
  if (focus[kind] !== workspace.id) { focus[kind] = workspace.id; persist(); emit(); }
  return workspace;
}
export function currentCreation(kind: CreationTool) { hydrate(); return workspaces.get(focus[kind] || '') || ensureCreation(kind, null); }
export function registerCreationSlot(kind: CreationTool, sessionId: string | null, node: HTMLElement) {
  const workspace = ensureCreation(kind, sessionId);
  slots.set(workspace.id, node); focus[kind] = workspace.id; persist();
  emit();
  return () => { if (slots.get(workspace.id) === node) { slots.delete(workspace.id); emit(); } };
}
export const creationSlot = (id: string) => slots.get(id);
export function creationSessionDeleted(sessionId: string) {
  hydrate();
  deleted.add(sessionId);
  clearChatDraft(sessionId);
  for (const workspace of workspaces.values()) if (workspace.sessionId === sessionId) slots.delete(workspace.id);
  for (const kind of ['image','publish'] as const) if (workspaces.get(focus[kind] || '')?.sessionId === sessionId) focus[kind] = null;
  persist();
  emit();
}
export const canReturnToSession = (sessionId: string | null) => { hydrate(); return Boolean(sessionId && !deleted.has(sessionId)); };
export function readCreationDraft(workspace: CreationWorkspace): PublishDraft {
  const raw = readLocalValue(key(workspace.id)).value;
  if (raw) try { const draft = JSON.parse(raw); if (typeof draft.title === 'string' && typeof draft.body === 'string' && typeof draft.tags === 'string' && Array.isArray(draft.platforms) && draft.platforms.every((x: unknown) => typeof x === 'string') && draft.overrides && typeof draft.overrides === 'object' && !Array.isArray(draft.overrides) && Object.values(draft.overrides).every(x => typeof x === 'string') && (draft.media === undefined || Array.isArray(draft.media) && draft.media.every((x: unknown) => typeof x === 'string'))) return draft; } catch { /* retain legacy draft separately */ }
  return workspace.sessionId ? { title:'', body:'', platforms:[], overrides:{}, tags:'', media:[] } : loadPublishDraft();
}
export function saveCreationDraft(workspace: CreationWorkspace, draft: PublishDraft) { return writeLocalValue(key(workspace.id), JSON.stringify(draft)); }
export function backupCreationDraft(workspace: CreationWorkspace, draft: unknown) { writeLocalValue(key(workspace.id) + ':previous', JSON.stringify(draft)); }
export function previousCreationDraft(workspace: CreationWorkspace): unknown { try { return JSON.parse(readLocalValue(key(workspace.id) + ':previous').value || 'null'); } catch { return null; } }
export function addImageToPublish(sessionId: string | null, url: string) {
  if (sessionId && !canReturnToSession(sessionId)) throw new Error('来源对话已删除，请选择其他目标');
  const path = localImage(url).pathname.split('/api/media/')[1];
  const workspace = ensureCreation('publish', sessionId);
  const draft = readCreationDraft(workspace);
  if ((draft.media || []).some(path => /\.(mp4|webm|mov|mkv)$/i.test(path))) throw new Error('发布草稿含视频，请先移除视频再添加图片');
  const media = decodeURIComponent(path);
  const next = {...draft, media:[...new Set([...(draft.media || []), media])]};
  if (!saveCreationDraft(workspace,next)) throw new Error('发布草稿未能保存，请检查浏览器存储');
  window.dispatchEvent(new CustomEvent('easel:creation-draft-updated', {detail:{workspaceId:workspace.id, draft:next}}));
  selectCreation('publish', sessionId);
}
export function returnCreationQuote(sessionId: string, text: string) {
  if (!canReturnToSession(sessionId)) throw new Error('目标对话已删除，请选择其他对话');
  if (!(getChatDraft(sessionId).quotes || []).includes(text.trim())) addChatDraftQuote(sessionId, text);
}
function localImage(url: string) {
  const target = new URL(url, window.location.href);
  const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  if (target.origin !== window.location.origin || target.username || target.password || !target.pathname.startsWith(base + '/api/media/') || !/\.(png|jpe?g|webp|gif)$/i.test(target.pathname)) throw new Error('仅能引用本机图片产物');
  return target;
}
export function returnImageToChat(sessionId: string, url: string): Promise<UploadedFile[]> {
  const insertion = sessionId + ':' + url;
  const pending = transfers.get(insertion);
  if (pending) return pending;
  const promise = insertImage(sessionId,url,insertion).finally(() => transfers.delete(insertion));
  transfers.set(insertion,promise);
  return promise;
}
export function returnGeneratedFileToChat(sessionId: string, path: string): Promise<UploadedFile[]> {
  if (!path || path.split(/[\\/]/).some(part => part === '..') || path.startsWith('/') || /^[a-z]+:/i.test(path)) return Promise.reject(new Error('文件路径无效'));
  const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  const url = base + '/api/media/' + path.split('/').map(encodeURIComponent).join('/');
  const insertion = sessionId + ':' + url;
  const pending = transfers.get(insertion);
  if (pending) return pending;
  const promise = insertImage(sessionId, url, insertion, true).finally(() => transfers.delete(insertion));
  transfers.set(insertion, promise);
  return promise;
}
async function insertImage(sessionId: string, url: string, insertion: string, generatedFile = false): Promise<UploadedFile[]> {
  if (!canReturnToSession(sessionId)) throw new Error('目标对话已删除');
  const target = generatedFile ? new URL(url, window.location.href) : localImage(url);
  const previous = returnedImages.get(insertion);
  if (previous?.every(file => getChatDraft(sessionId).attachments.some(item => item.path === file.path))) return previous;
  const token = beginChatDraftUpload(sessionId);
  if (!token) throw new Error('对话附件正在上传，请稍后重试');
  let error = '';
  try {
    const response = await fetch(target.href);
    if (!response.ok) throw new Error('文件已失效，请重新读取产物');
    const blob = await response.blob();
    if ((!generatedFile && !blob.type.startsWith('image/')) || blob.size > 32 * 1024 * 1024) throw new Error('文件类型或大小不支持（最大32MB）');
    if (!canReturnToSession(sessionId)) throw new Error('目标对话已删除，未上传图片');
    const name = decodeURIComponent(target.pathname.split('/').at(-1) || 'image.png');
    const files = await uploadFiles([new File([blob], name, {type:blob.type})], sessionId);
    if (!canReturnToSession(sessionId)) throw new Error('目标对话已删除，未写入草稿');
    appendChatDraftUploads(sessionId, token, files);
    returnedImages.set(insertion,files);
    return files;
  } catch (reason) { error = reason instanceof Error ? reason.message : '图片引用失败'; throw reason; }
  finally { if (canReturnToSession(sessionId)) finishChatDraftUpload(sessionId, token, error); }
}
const receiptKey = 'easel:creation-receipt-origins';
export function bindCreationReceipt(receiptId: string, sessionId: string | null) {
  if (!sessionId) return;
  let origins: Record<string,string> = {};
  try { origins = JSON.parse(readLocalValue(receiptKey).value || '{}'); } catch { /* optional index */ }
  origins[receiptId] = sessionId; writeLocalValue(receiptKey, JSON.stringify(origins));
}
export function creationReceiptSession(receipt: PublishReceipt): string | null {
  if (receipt.sourceSessionId && /^[A-Za-z0-9_.-]{1,200}$/.test(receipt.sourceSessionId)) return receipt.sourceSessionId;
  try { return JSON.parse(readLocalValue(receiptKey).value || '{}')[receipt.receiptId] || null; } catch { return null; }
}

import type { ChatErrorDetail } from './chatErrors';
import type { UploadedFile, ChatQuestion } from './api';
import { chatErrorDetail } from './chatErrors';
import { readLocalValue, writeLocalValue, removeMigratedLocalValue, reportLocalPersistenceFailure } from './localPersistence';
import { hasChatDraft } from './chatDrafts';
import { requirementsForSelection } from './selectedSkills';
import type { SkillRequirements } from './selectedSkills';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  error?:ChatErrorDetail;
  agentContent?: string; // 仅发给 Agent 的增强消息（如附件路径），不在对话页面展示
  attachments?: UploadedFile[]; // 结构化附件引用；仅用于请求/重试，不在消息气泡展示
  selectedSkills?: string[];
  skillRequirements?: SkillRequirements; // Immutable requirements attached to this sent message, used on retry.
  turnId?: string;
  thinking?: string;   // 模型服务实际返回的思考内容或摘要，流式结束后持久保留
  activity?: string;   // 工具/执行活动步骤（换行分隔），持久保留
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  persona?: string;
  created: number;
  sessionKey?: string;  // OpenClaw 的 session key，用于后端删除
  pendingTurnId?: string; // 进行中的可重连 job；浏览器重开后继续按 eventId 续流
  archived?: boolean;   // 归档：从 History 主列表移到「已归档」区
  importedFromBackup?: boolean; // 只读备份记录，不关联后台上下文或恢复任务
  backupIncomplete?: boolean; // 备份时仍在进行，仅保留已收到的内容
}

/** 进行中的流式状态（存于 App，不随页面切换/ChatPage 卸载而丢失）。 */
export interface StreamState {
  content: string;
  thinking: string;
  activity: string;
  stillWorking?: string;   // 防呆心跳提示（未卡住）；独立于 activity，不覆盖真实状态
  questions: ChatQuestion[];   // ask_user 问答题卡片（进行中）
}

/** 发布中心草稿：持久化到 localStorage，切页/刷新都不丢。 */
export interface PublishDraft {
  title: string;
  body: string;
  platforms: string[];
  overrides: Record<string, string>;
  tags: string;   // 话题标签，逗号分隔（小红书绑话题；其它平台按需写入）
}
const PUBLISH_KEY = 'easel_publish_draft';
const PREVIOUS_BRAND = ['post', 'craft'].join('');

// Importing this module must not inspect or reset a user's browser storage.
// Decode before migration, and keep the source unless its replacement commits.
function readMigrated<T>(key: string, previousKeys: string[], decode: (raw: string) => T): { value?: T; readable: boolean } {
  let readable = true;
  for (const source of [key, ...previousKeys]) {
    const result = readLocalValue(source);
    if (!result.ok) return { readable: false };
    if (result.value === null) continue;
    try {
      const value = decode(result.value);
      // A valid fallback can recover the UI, but it cannot establish that an
      // earlier unreadable source is safe to overwrite or remove.
      if (readable && source !== key && writeLocalValue(key, result.value)) removeMigratedLocalValue(source);
      return { value, readable };
    } catch {
      readable = false;
      reportLocalPersistenceFailure(source, 'read', 'invalid');
    }
  }
  return { readable };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const PUBLISH_DEFAULT: PublishDraft = {
  title: '', body: '', platforms: ['xiaohongshu', 'douyin'], overrides: {}, tags: '',
};
export function loadPublishDraft(): PublishDraft {
  if (draftInMemory) return draftInMemory;
  const loaded = readMigrated(PUBLISH_KEY, [`${PREVIOUS_BRAND}_publish_draft`], raw => {
    const value: unknown = JSON.parse(raw);
    if (!record(value)) throw new Error('Invalid draft');
    return {
      title: typeof value.title === 'string' ? value.title : '',
      body: typeof value.body === 'string' ? value.body : '',
      tags: typeof value.tags === 'string' ? value.tags : '',
      platforms: Array.isArray(value.platforms) ? value.platforms.filter((p): p is string => typeof p === 'string') : [...PUBLISH_DEFAULT.platforms],
      overrides: record(value.overrides) ? Object.fromEntries(Object.entries(value.overrides).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {},
    };
  });
  draftUnreadable = !loaded.readable;
  return loaded.value || { ...PUBLISH_DEFAULT, platforms: [...PUBLISH_DEFAULT.platforms], overrides: {} };
}
let draftInMemory: PublishDraft | undefined;
let draftUnreadable = false;
export function savePublishDraft(d: PublishDraft): boolean {
  draftInMemory = d;
  return saveJson(PUBLISH_KEY, d, draftUnreadable);
}

const STORAGE_KEY = 'easel_sessions';
const ACTIVE_KEY = 'easel_active_session';
const TITLE_MAX_CHARS = 24;

/** 上次活跃会话 id：重开网页时据此续接上次对话（而不是丢进新空会话）。 */
export function loadActiveId(): string | null {
  if (activeInMemory !== undefined) return activeInMemory;
  return readMigrated(ACTIVE_KEY, [`${PREVIOUS_BRAND}_active_session`], raw => raw.trim() || null).value ?? null;
}
let activeInMemory: string | null | undefined;
export function saveActiveId(id: string | null): boolean {
  activeInMemory = id;
  // An empty current value also prevents a retained legacy ID from resurfacing.
  return writeLocalValue(ACTIVE_KEY, id || '');
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function normalizeMessage(value: unknown, migrateAttachmentText = true): ChatMessage | null {
  if (!record(value) || (value.role !== 'user' && value.role !== 'assistant')) return null;
  const message: ChatMessage = { role: value.role, content: typeof value.content === 'string' ? value.content : '' };
  for (const key of ['agentContent', 'turnId', 'thinking', 'activity'] as const) {
    if (typeof value[key] === 'string') message[key] = value[key];
  }
  if (Array.isArray(value.selectedSkills)) message.selectedSkills = value.selectedSkills.filter((skill): skill is string => typeof skill === 'string');
  if (value.skillRequirements !== undefined) message.skillRequirements = requirementsForSelection(value.skillRequirements, message.selectedSkills || []);
  if (Array.isArray(value.attachments)) {
    message.attachments = value.attachments.filter((file): file is UploadedFile => record(file)
      && typeof file.id === 'string' && typeof file.name === 'string' && typeof file.path === 'string');
  }
  if (typeof value.error === 'string' || (record(value.error) && typeof value.error.message === 'string')) message.error = chatErrorDetail(value.error);
  if (migrateAttachmentText && message.role === 'user' && !message.agentContent && message.content.includes('【附件素材】')) {
    message.agentContent = message.content;
    message.content = message.content.split('【附件素材】', 1)[0].trim();
  }
  return message;
}

function decodeSessions(raw: string): ChatSession[] {
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values)) throw new Error('Invalid session list');
  const sessions: ChatSession[] = [];
  const usedIds = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (!record(value)) continue;
    const messages = Array.isArray(value.messages)
      ? value.messages.map(message => normalizeMessage(message, value.importedFromBackup !== true)).filter((message): message is ChatMessage => message !== null)
      : [];
    let id = typeof value.id === 'string' && value.id.trim() ? value.id : `recovered-${index}`;
    while (usedIds.has(id)) id += '-recovered';
    usedIds.add(id);
    const session: ChatSession = {
      id, messages,
      title: typeof value.title === 'string' && value.title.trim() ? value.title : 'New Chat',
      created: typeof value.created === 'number' && Number.isFinite(value.created) ? value.created : 0,
    };
    for (const key of ['persona', 'sessionKey', 'pendingTurnId'] as const) if (typeof value[key] === 'string') session[key] = value[key];
    if (typeof value.archived === 'boolean') session.archived = value.archived;
    if (value.importedFromBackup === true) {
      session.importedFromBackup = true;
      session.backupIncomplete = value.backupIncomplete === true;
      delete session.sessionKey;
      delete session.pendingTurnId;
      delete session.persona;
      for (const message of session.messages) {
        delete message.turnId;
        delete message.agentContent;
        delete message.attachments;
        delete message.selectedSkills;
        delete message.skillRequirements;
      }
    }
    sessions.push(session);
  }
  return sessions;
}

let sessionsInMemory: ChatSession[] | undefined;
let sessionsUnreadable = false;
export function loadSessions(): ChatSession[] {
  if (sessionsInMemory) return sessionsInMemory;
  const loaded = readMigrated(STORAGE_KEY, ['easel-sessions', `${PREVIOUS_BRAND}_sessions`], decodeSessions);
  sessionsUnreadable = !loaded.readable;
  return loaded.value || [];
}

/** Prune duplicate empty placeholders only; never silently truncate real history. */
function prune(sessions: ChatSession[]): ChatSession[] {
  let keptEmpty = false;
  const pruned = sessions.filter((s) => {
    if (s.messages.length > 0 || s.pendingTurnId || (!s.importedFromBackup && hasChatDraft(s.id))) return true;
    if (keptEmpty) return false;
    keptEmpty = true;
    return true;
  });
  return pruned;
}

function saveJson(key: string, value: unknown, unreadable: boolean): boolean {
  // A failed initial read is not an empty history. Keep it untouched rather
  // than replacing it when the UI creates its first in-memory placeholder.
  if (unreadable) {
    reportLocalPersistenceFailure(key, 'write', 'unreadable');
    return false;
  }
  try { return writeLocalValue(key, JSON.stringify(value)); }
  catch {
    reportLocalPersistenceFailure(key, 'write', 'invalid');
    return false;
  }
}

export function saveSessions(sessions: ChatSession[]): boolean {
  sessionsInMemory = sessions;
  return saveJson(STORAGE_KEY, prune(sessions), sessionsUnreadable);
}

export function createSession(persona?: string): ChatSession {
  return {
    id: generateId(),
    title: 'New Chat',
    messages: [],
    persona,
    created: Date.now(),
  };
}

type TitleIntent = 'issue' | 'create' | 'optimize' | 'publish' | 'inspect' | 'general';

function titleIntent(text: string): TitleIntent {
  // 明确请求比“有点问题”更能表达用户意图，所以 issue 放在最后。
  if (/(?:优化|改进|调整|完善|增强|多样|随机)/.test(text)) return 'optimize';
  if (/(?:发布|投稿|分发)|(?:上传.*(?:平台|账号|小红书|抖音|B站|bilibili))/i.test(text)) return 'publish';
  if (/(?:制作|生成|创建|设计|写一|做一|剪辑|合成)/.test(text)) return 'create';
  if (/(?:检查|排查|分析|看看|查看|确认|什么逻辑)/.test(text)) return 'inspect';
  if (/(?:bug|修复|解决|问题|异常|报错|失败|卡住|断开|不对|不生效|混乱|拉伸)/i.test(text)) return 'issue';
  return 'general';
}

function semanticTopic(text: string, fallback: string): string {
  if (/(?:历史)?会话.*(?:命名|标题|主题|名字)|(?:命名|标题|主题|名字).*(?:历史)?会话/.test(text)) return '历史会话标题';
  if (/(?:模型)?回答(?:完成|完).*?(?:运行|断开)|(?:运行|断开).*?(?:模型)?回答(?:完成|完)/.test(text)) return '对话完成状态';
  if (/(?:paper-explainer|paper explainer).*(?:skill|逻辑|流程)|(?:skill|逻辑|流程).*(?:paper-explainer|paper explainer)/i.test(text)) return 'paper-explainer 逻辑';
  if (/(?:论文|paper).*(?:ppt|slide).*(?:拉伸|移动|缩放|画面)|(?:拉伸|移动|缩放).*(?:ppt|slide)/i.test(text)) return '论文 PPT 画面';
  if (/(?:论文|paper).*(?:ppt|slide|幻灯|讲解)|(?:ppt|slide|幻灯).*(?:论文|paper)/i.test(text)) return '论文讲解 PPT';
  if (/(?:附件|素材).*(?:上传|重名|多个|显示|隐藏)|(?:上传|重名).*(?:附件|素材)/.test(text)) return '附件上传';
  if (/(?:小红书|xhs).*种草.*文案/i.test(text)) return '小红书种草文案';
  if (/(?:小红书|xhs).*(?:文案|笔记|卡片)/i.test(text)) return '小红书内容';
  if (/交接文档.*项目|项目.*交接文档/.test(text)) return '项目交接';
  if (/视频.*(?:横版|竖版|画幅)|(?:横版|竖版|画幅).*视频/.test(text)) return '视频画幅';
  if (/配置.*模型|模型.*配置/.test(text)) return '模型配置';

  const quoted = text.match(/[「『“"]([^」』”"]{2,24})[」』”"]/u)?.[1];
  if (quoted && /(?:围绕|关于|选题|主题|热点)/.test(text)) return quoted.trim();

  const publishTarget = text.match(/^(?:把|将)?(.{2,18}?)(?:发布|投稿|分发)(?:到|至|去|给)/)?.[1];
  if (publishTarget) return publishTarget.trim();

  return fallback
    .replace(/^(?:做|制作|生成|创建|设计|写|检查|排查|分析|优化|改进|调整|修复)(?:一个|一条|一份|个|条|份)?/, '')
    .replace(/(?:有个|出现了?|遇到)?\s*(?:bug|问题|异常|报错|有点乱).*$/i, '')
    .replace(/[，,、：:\s]+$/g, '')
    .trim() || fallback;
}

function cleanTitleClause(value: string): string {
  return value
    .replace(/^(?:(?:然后|还有|另外|对了|那个|嗯|就是|首先|先说一下|麻烦你?|请问|请你?|能不能|能否|是否可以|可不可以|你能否|你可以|我想(?:要|让你)?|想让你|帮忙|帮我|给我|先|看看|看一下|看下|查一下|查下|确认一下|确认下|我发现|我觉得)[，,、：:\s]*)+/g, '')
    .replace(/^(?:现在|目前|当前)的?/g, '')
    .replace(/[吗么呢吧啊呀哦]+[？?！!。.]?$/g, '')
    .trim();
}

function chooseFocusClause(text: string): string {
  const clauses = text.split(/[。！？?!；;\n，,]/).map(cleanTitleClause).filter(Boolean);
  if (!clauses.length) return text;
  const domain = /(?:skill|paper-explainer|会话|历史|标题|命名|附件|素材|论文|ppt|slide|视频|字幕|配音|发布|小红书|抖音|图片|模型|配置|项目|页面|前端)/i;
  const action = /(?:优化|修复|改进|调整|制作|生成|创建|发布|分析|排查|检查)/;
  return clauses.reduce((best, clause) => {
    const score = (domain.test(clause) ? 4 : 0) + (action.test(clause) ? 2 : 0)
      - (/(?:有可能|是不是|为什么|怎么回事|有点)/.test(clause) ? 1 : 0)
      - Math.max(0, Array.from(clause).length - 28) / 20;
    const bestScore = (domain.test(best) ? 4 : 0) + (action.test(best) ? 2 : 0)
      - (/(?:有可能|是不是|为什么|怎么回事|有点)/.test(best) ? 1 : 0)
      - Math.max(0, Array.from(best).length - 28) / 20;
    return score > bestScore ? clause : best;
  }, clauses[0]);
}

/** 从首条提问提取“主题对象 + 动作”；确定性生成，不请求模型或后端。 */
export function generateSessionTitle(message: string, _seed = message): string {
  const attachmentMarker = '【附件素材】';
  const [question = '', attachmentBlock = ''] = message.split(attachmentMarker, 2);
  let text = question
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text && attachmentBlock) {
    const path = attachmentBlock.match(/outputs\/([^\s]+)/)?.[1] || '';
    const filename = path.split('/').pop() || '上传素材';
    text = `处理附件 ${filename}`;
  }

  text = cleanTitleClause(text);
  const focusClause = chooseFocusClause(text);
  const baseTitle = focusClause
    .replace(/^(.+?)配置的?是什么模型$/i, '$1模型配置')
    .replace(/^对(.+?)进行/g, '$1')
    .replace(/然后(?:再)?(?:对)?/g, '')
    .replace(/进行|这个|一下/g, '')
    .replace(/(?:怎么|如何|怎样)(?:去)?/g, '')
    .replace(/(?:是不是|是否|是什么|有哪些|有啥)$/g, '')
    .replace(/[吗么呢吧啊呀]+$/g, '')
    .replace(/[，,、：:\s]+$/g, '')
    .trim();

  const core = Array.from(semanticTopic(text, baseTitle || '新对话'))
    .slice(0, 18).join('')
    .replace(/(?:问题排查|故障分析|异常|问题|优化|改进|分析|检查|制作|生成|发布)$/g, '')
    .trim() || '新对话';
  const intent = titleIntent(text);
  const titles: Record<TitleIntent, string> = {
    issue: `${core}问题排查`,
    create: /(?:文案|脚本|方案)$/.test(core) ? core : `${core}制作`,
    optimize: `${core}优化`,
    publish: `${core}发布`,
    inspect: `${core}分析`,
    general: core,
  };
  const title = titles[intent] || core;
  const chars = Array.from(title);
  return chars.length > TITLE_MAX_CHARS
    ? `${chars.slice(0, TITLE_MAX_CHARS).join('')}…`
    : title;
}

export function updateSessionTitle(session: ChatSession): void {
  const first = Array.isArray(session.messages) ? session.messages[0] : undefined;
  if (first && session.title === 'New Chat') {
    session.title = generateSessionTitle(first.content || '', session.id);
  }
}

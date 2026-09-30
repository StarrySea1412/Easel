import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangeEvent } from 'react';
import { MAX_BACKUP_BYTES, parseConversationBackup } from '../../lib/conversationBackup';
import type { ConversationBackup } from '../../lib/conversationBackup';
import type { RawConversationStorageBackup } from '../../lib/conversationStorageBackup';
import { getLocalPersistenceStatus, retryPendingLocalWrites, subscribeLocalPersistence } from '../../lib/localPersistence';
import type { LocalPersistenceStatus } from '../../lib/localPersistence';
import '../../styles/conversation-backup.css';

export interface ConversationBackupCardProps {
  onExport: () => ConversationBackup;
  onExportRaw: () => RawConversationStorageBackup;
  onImport: (backup: ConversationBackup) => { count: number; firstSessionId?: string };
  onOpenSession: (id: string) => void;
}

type Preview = { filename: string; backup: ConversationBackup };
type ImportResult = { count: number; firstSessionId?: string };

function downloadJson(value: ConversationBackup | RawConversationStorageBackup, name: string): void {
  // Use the same compact serialization as the portable backup's size limit.
  const blob = new Blob([JSON.stringify(value)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Browsers may consume the URL after the click handler returns. Keep it
    // alive through navigation/unmount, then release it without touching React.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export default function ConversationBackupCard({ onExport, onExportRaw, onImport, onOpenSession }: ConversationBackupCardProps) {
  const headingId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const readVersion = useRef(0);
  const importAttempted = useRef(false);
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retrySnapshot, setRetrySnapshot] = useState<LocalPersistenceStatus | null>(null);
  const storage = useSyncExternalStore(subscribeLocalPersistence, getLocalPersistenceStatus);

  useEffect(() => () => { readVersion.current++; }, []);

  const cancel = () => {
    readVersion.current++;
    importAttempted.current = false;
    setReading(false);
    setPreview(null);
    setError('');
    setNotice('');
    if (fileInput.current) fileInput.current.value = '';
  };

  const selectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = ''; // The same file can be selected after a failure.
    const version = ++readVersion.current;
    importAttempted.current = false;
    setPreview(null);
    setResult(null);
    setError('');
    setNotice('');
    setRetrySnapshot(null);
    setReading(Boolean(file));
    if (!file) return;
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error('备份文件超过 20 MiB，请选择较小的会话备份。');
      if (file.size === 0) throw new Error('备份文件为空，请重新选择。');
      const text = await file.text();
      if (version !== readVersion.current) return;
      const backup = parseConversationBackup(text);
      setPreview({ filename: file.name, backup });
    } catch (cause) {
      if (version === readVersion.current) setError(cause instanceof Error ? cause.message : '备份文件读取失败，请重新选择。');
    } finally {
      if (version === readVersion.current) setReading(false);
    }
  };

  const exportBackup = (raw: boolean) => {
    setError('');
    setNotice('');
    try {
      if (raw) {
        const backup = onExportRaw();
        downloadJson(backup, 'easel-raw-conversation-storage');
        const unavailable = backup.entries.filter(entry => !entry.readable).length;
        setNotice(`已发起原始存储下载，请在浏览器下载列表确认。${unavailable ? `原始备份有 ${unavailable} 项读取失败，文件已标明读取状态。` : ''}`);
      } else {
        const backup = onExport();
        downloadJson(backup, 'easel-conversations');
        setNotice(`已发起 ${backup.sessions.length} 个会话的备份下载，请在浏览器下载列表确认。`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? `导出失败：${cause.message}` : '导出失败，请稍后重试。');
    }
  };

  const confirmImport = () => {
    if (!preview || importAttempted.current || reading) return;
    // State updates alone cannot reject two clicks in the same event batch.
    importAttempted.current = true;
    setError('');
    setNotice('');
    try {
      const imported = onImport(preview.backup);
      if (!Number.isInteger(imported.count) || imported.count <= 0) throw new Error('未新增会话记录。');
      setResult(imported);
      setPreview(null);
    } catch (cause) {
      setError(`导入未完成：${cause instanceof Error ? cause.message : '请核对当前会话记录。'} 请先核对记录，需要再次尝试时重新选择文件。`);
    }
  };

  const sessions = preview?.backup.sessions || [];
  const messages = sessions.reduce((count, session) => count + session.messages.length, 0);
  return (
    <section className="conversation-backup-card" aria-labelledby={headingId}>
      <header className="conversation-backup-heading">
        <h2 id={headingId}>会话备份</h2>
        <p>在本机导出、解析和导入会话，不上传备份文件。不包含附件文件，不读取模型配置或平台凭据；文件含对话内容，请妥善保存。</p>
      </header>

      <div className="conversation-backup-actions">
        <button type="button" className="btn btn-sm" onClick={() => exportBackup(false)}>导出会话备份</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => fileInput.current?.click()}>选择备份文件</button>
        <input ref={fileInput} type="file" accept=".json,application/json" aria-label="选择会话备份文件" hidden onChange={event => void selectFile(event)} />
      </div>
      <p className="conversation-backup-help">导出当前页面可用的历史，包含尚未保存的更改和进行中会话的未完成快照。导入文件最大 20 MiB。</p>

      <details className="conversation-backup-raw">
        <summary>原始存储备份（排障用）</summary>
        <p>原样导出浏览器中的会话存储，可能包含旧后台关联，仅用于排障。此排障文件不能通过会话导入入口直接导入，导出不会清除原始值。</p>
        <button type="button" className="btn btn-sm" onClick={() => exportBackup(true)}>导出原始存储</button>
      </details>

      {reading && <div className="conversation-backup-reading" role="status" aria-busy="true">
        <span>正在本机读取备份…</span>
        <button type="button" className="btn btn-sm" onClick={cancel}>取消读取</button>
      </div>}

      {preview && <div className="conversation-backup-preview" aria-label="备份导入预览">
        <h3>导入预览</h3>
        <p className="conversation-backup-filename">{preview.filename}</p>
        <dl className="conversation-backup-counts">
          <div><dt>会话</dt><dd>{sessions.length}</dd></div>
          <div><dt>消息</dt><dd>{messages}</dd></div>
          <div><dt>未完成</dt><dd>{sessions.filter(session => session.incomplete).length}</dd></div>
          <div><dt>归档</dt><dd>{sessions.filter(session => session.archived).length}</dd></div>
        </dl>
        <ul className="conversation-backup-titles">
          {sessions.slice(0, 5).map((session, index) => <li key={index}>{session.title || '未命名会话'}</li>)}
        </ul>
        {sessions.length > 5 && <p className="conversation-backup-help">另有 {sessions.length - 5} 个会话。</p>}
        <p className="conversation-backup-import-note">确认后仅新增只读副本，保留现有会话；不会恢复原后台上下文，也不会继续执行未完成任务，附件及媒体不会自动加载。</p>
        <p className="conversation-backup-import-note">再次选择同一文件并确认导入，会新增另一批副本。</p>
        <div className="conversation-backup-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={confirmImport} disabled={importAttempted.current}>确认导入只读副本</button>
          <button type="button" className="btn btn-sm" onClick={cancel}>取消导入</button>
        </div>
      </div>}

      {error && <p className="conversation-backup-error" role="alert">{error}</p>}
      {notice && <p className="conversation-backup-notice" role="status">{notice}</p>}

      {result && <div className="conversation-backup-result" role="status">
        <p>已新增 {result.count} 个只读会话副本。</p>
        {storage.unsaved && <div className="conversation-backup-unsaved">
          <p>导入副本目前仅确认保留在当前页面，请勿重复导入。可重试保存，或先导出会话备份。</p>
          <p>{storage.message}{retrySnapshot === storage ? ' 重试仍未成功，请保留当前页面。' : ''}</p>
          <button type="button" className="btn btn-sm" onClick={() => setRetrySnapshot(retryPendingLocalWrites() ? null : getLocalPersistenceStatus())}>重试保存导入记录</button>
        </div>}
        {result.firstSessionId && <button type="button" className="btn btn-sm" onClick={() => onOpenSession(result.firstSessionId!)}>打开首个导入记录</button>}
      </div>}
    </section>
  );
}

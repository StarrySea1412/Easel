import { useState, useSyncExternalStore } from 'react';
import { getLocalPersistenceStatus, retryPendingLocalWrites, subscribeLocalPersistence } from '../lib/localPersistence';
import type { LocalPersistenceStatus } from '../lib/localPersistence';

/** Lives outside page boundaries so unsaved history remains visible on navigation. */
export default function StorageNotice() {
  const status = useSyncExternalStore(subscribeLocalPersistence, getLocalPersistenceStatus);
  const [failedSnapshot, setFailedSnapshot] = useState<LocalPersistenceStatus | null>(null);
  if (!status.message) return null;
  return (
    <div className="local-storage-notice" role="status">
      <p>{status.message}{failedSnapshot === status && ' 重试尚未成功，当前内容仍保留在本页。'}</p>
      {status.unsaved && <button type="button" className="btn" onClick={() => {
        setFailedSnapshot(retryPendingLocalWrites() ? null : getLocalPersistenceStatus());
      }}>重试保存</button>}
    </div>
  );
}

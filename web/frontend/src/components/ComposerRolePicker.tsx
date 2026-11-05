import { useEffect, useMemo, useState } from 'react';
import Select from './ui/Select';
import { fetchAgentRoles, type AgentRole } from '../lib/api';
import { readLocalValue, writeLocalValue } from '../lib/localPersistence';
import '../styles/composer-role-picker.css';

const keyFor = (sessionId: string) => `easel:agent-role:${sessionId}`;

export default function ComposerRolePicker({sessionId, value, onChange, disabled}: {
  sessionId: string;
  value?: string;
  onChange: (roleId?: string) => void;
  disabled?: boolean;
}) {
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const saved = readLocalValue(keyFor(sessionId));
    if (saved.ok && saved.value && !value) onChange(saved.value);
  }, [sessionId, value, onChange]);
  useEffect(() => {
    let disposed = false;
    void fetchAgentRoles().then(result => {
      if (!disposed) {
        // Older gateways and isolated composer fixtures may answer without
        // the optional role payload; keep the picker usable in that case.
        setRoles(Array.isArray(result.roles) ? result.roles : []);
        setError('');
      }
    }).catch(() => { if (!disposed) setError('角色列表暂不可读'); });
    return () => { disposed = true; };
  }, [sessionId]); // selection is owned by the composer; fetch once per session
  const selected = useMemo(() => roles.find(role => role.id === value), [roles, value]);
  const choose = (next: string) => {
    const roleId = next || undefined;
    onChange(roleId);
    if (roleId) writeLocalValue(keyFor(sessionId), roleId);
    else writeLocalValue(keyFor(sessionId), '');
  };
  return <div className="composer-role-picker" title={selected?.toolPolicy || '角色是本轮请求契约，不改变权限'}>
    <span className="composer-role-label">角色</span>
    <Select aria-label="本轮 Agent 角色" value={value || ''} disabled={Boolean(disabled) || !roles.length}
      options={[{value: '', label: roles.length ? '自动编排' : error || '读取角色…'}, ...roles.map(role => ({value: role.id, label: role.shortName}))]}
      onChange={choose}/>
    {selected && <span className="composer-role-description">{selected.description}</span>}
  </div>;
}

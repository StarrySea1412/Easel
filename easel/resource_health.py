"""Read-only memory admission evidence; never restart services or change budgets."""
from pathlib import Path

MIB = 1024 * 1024


def memory_snapshot(cgroup=Path('/sys/fs/cgroup'), meminfo=Path('/proc/meminfo')):
    result = {'state': 'unknown', 'source': 'unavailable', 'oomKills': None}
    headroom = []
    limits = []
    for source, used_path, limit_path in (
            ('cgroup-v2', cgroup / 'memory.current', cgroup / 'memory.max'),
            ('cgroup-v1', cgroup / 'memory/memory.usage_in_bytes', cgroup / 'memory/memory.limit_in_bytes')):
        try:
            used = int(used_path.read_text().strip())
            limit = int(limit_path.read_text().strip())
            if not 0 < limit < 2 ** 60 or used < 0:
                continue
            result.update(source=source, usedBytes=used, limitBytes=limit)
            headroom.append(max(0, limit - used))
            limits.append(limit)
            break
        except (OSError, ValueError):
            continue
    try:
        fields = dict(line.split(':', 1) for line in meminfo.read_text().splitlines() if ':' in line)
        available = int(fields['MemAvailable'].split()[0]) * 1024
        total = int(fields['MemTotal'].split()[0]) * 1024
        if available >= 0 and total > 0:
            result.update(hostAvailableBytes=available)
            headroom.append(available)
            limits.append(total)
            if result['source'] == 'unavailable':
                result['source'] = 'host'
    except (OSError, KeyError, ValueError, IndexError):
        pass
    try:
        events = dict(line.split() for line in (cgroup / 'memory.events').read_text().splitlines())
        result['oomKills'] = int(events['oom_kill'])
    except (OSError, ValueError, KeyError):
        pass
    if headroom:
        reserve = max(256 * MIB, min(limits) * 15 // 100)
        available = min(headroom)
        result.update(headroomBytes=available, reserveBytes=reserve,
                      state='pressure' if available < reserve else 'available')
    return result


def require_memory_capacity():
    if memory_snapshot()['state'] == 'pressure':
        from fastapi import HTTPException
        raise HTTPException(503, {'code': 'server_memory_pressure', 'category': 'execution',
            'retryable': True, 'stage': 'resource_admission',
            'message': '服务器当前内存不足，本次任务尚未派发。已保留输入，请稍后手动继续。'},
            headers={'Retry-After': '15'})

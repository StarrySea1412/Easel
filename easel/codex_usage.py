"""Numeric-only accounting for the app server's thread usage notifications."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

KEYS = ('inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens')


def context(state, sid, model_ref=''):
    if len(model_ref) > 300 or any(ord(c) < 32 for c in model_ref):
        raise ValueError('Invalid model identity')
    raw = state.get('tokenUsage') or {}
    last = counts(raw.get('last')) or {}
    requested = state.get('requestedModelRef') or ''
    changed = bool(model_ref and requested and model_ref != requested)
    capacity = raw.get('modelContextWindow')
    capacity = capacity if type(capacity) is int and 0 < capacity <= 10**12 else None
    return dict(sessionId=sid, modelRef=model_ref or requested, observedModelRef=state.get('actualModel') or requested,
        capacity=None if changed else capacity, capacitySource='runtime' if capacity and not changed else 'unavailable',
        usedTokens=None if changed else last.get('inputTokens'), usageSource='model_changed' if changed else 'last_request',
        updatedAt=state.get('usageAt') or state.get('startedAt'), stale=True,
        breakdown=[], breakdownStatus='unavailable',
        note='Codex 最近一次请求输入快照（含缓存），不是线程累计量，也不是实时编辑中的上下文。缺少通知时不估算。',
        breakdownNote='Codex 未上报消息、工具和技能的分类分词，不能用总量按比例分摊。')


def counts(value):
    if not isinstance(value, dict):
        return None
    return {key: value[key] if type(value.get(key)) is int and 0 <= value[key] <= 10**15 else None for key in (*KEYS, 'cacheWriteInputTokens')}


def observe(state, raw):
    if not isinstance(raw, dict):
        return
    total, last = counts(raw.get('total')), counts(raw.get('last'))
    if not total or total['totalTokens'] is None:
        return
    previous = counts(state.get('usageCursor'))
    if previous and total == previous:
        return  # Replayed notifications must not create a second charge.
    monotonic = previous and all(total[k] is not None and previous[k] is not None and total[k] >= previous[k] for k in KEYS)
    values = {k: total[k] - previous[k] for k in KEYS} if monotonic else last
    if monotonic:
        a, b = total.get('cacheWriteInputTokens'), previous.get('cacheWriteInputTokens')
        values['cacheWriteInputTokens'] = a - b if a is not None and b is not None and a >= b else None
    if values and values.get('totalTokens') is not None:
        state.setdefault('usageRecords', []).append(dict(values=values, source='thread_delta' if monotonic else 'last_request',
            complete=bool(monotonic)))
    state['usageCursor'] = total
    state['tokenUsage'] = {k: v for k, v in dict(total=total, last=last, modelContextWindow=raw.get('modelContextWindow')).items() if v is not None}


def calls(outputs: Path):
    """Only Easel-owned bindings; never scan the user's global Codex history."""
    result, issues, source_count = [], [], 0
    root = outputs / '_codex'
    for binding_path in root.glob('*/session.json'):
        try:
            if binding_path.is_symlink() or binding_path.parent.is_symlink():
                continue
            binding = json.loads(binding_path.read_text(encoding='utf-8'))
            sid = binding.get('sessionId')
            if binding.get('engine') != 'codex' or not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}', sid):
                continue
            if binding_path.parent.name != hashlib.sha256(sid.encode()).hexdigest():
                continue
            for path in (binding_path.parent / 'turns').glob('*.json'):
                if path.is_symlink():
                    continue
                state = json.loads(path.read_text(encoding='utf-8'))
                tid = state.get('turn_id')
                if state.get('sessionId') != sid or not isinstance(tid, str) or path.stem != hashlib.sha256(tid.encode()).hexdigest():
                    continue
                source_count += 1
                records = state.get('usageRecords')
                if not isinstance(records, list):
                    last = counts((state.get('tokenUsage') or {}).get('last'))
                    records = [dict(values=last, source='last_request', complete=False)] if last else []
                if not records:
                    issues.append('部分 Codex 轮次未上报用量；未从文本长度或线程累计值猜填。')
                for index, record in enumerate(records):
                    values = counts(record.get('values'))
                    if not values:
                        continue
                    result.append(dict(id=hashlib.sha256(f'codex:{sid}:{tid}:{index}'.encode()).hexdigest(), sessionId=sid,
                        turnId=hashlib.sha256(f'codex:{sid}:{tid}'.encode()).hexdigest(), turnIndex=1, line=index,
                        timestamp=state.get('usageAt') or state.get('startedAt'), model=str(state.get('actualModel') or state.get('requestedModelRef') or '未上报')[:160],
                        provider='codex', engine='codex', inputTokens=values['inputTokens'], outputTokens=values['outputTokens'],
                        cacheReadTokens=values['cachedInputTokens'], cacheWriteTokens=values['cacheWriteInputTokens'], reasoningTokens=values['reasoningOutputTokens'], totalTokens=values['totalTokens'],
                        recordedCostUsd=None, estimatedCostUsd=None, durationMs=None, firstTokenMs=None,
                        speedSource=None, outputTokensPerSecond=None, costBreakdown=None, usageSource=record.get('source'), usageComplete=record.get('complete') is True))
                    if record.get('complete') is not True:
                        issues.append('部分 Codex 历史仅有最后一次请求快照，汇总为已知下限，不能代表整轮消耗。')
        except (OSError, ValueError, TypeError, AttributeError):
            issues.append('部分 Codex 用量记录暂不可读，已有账本仍保留。')
    return result, issues, source_count

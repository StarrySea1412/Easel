"""Deterministic account-scoped analysis; no model, algorithm weights or causality."""
from __future__ import annotations

import hashlib
import json
import math
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone

ADVANCED_METRICS = ('impressions', 'completions', 'averageWatchSeconds', 'durationSeconds',
                    'followersAttributed', 'coins', 'danmaku')
PRIMARY_METRICS = {'xiaohongshu': 'collects', 'bilibili': 'collects', 'douyin': 'shares',
                   'kuaishou': 'comments', 'weixin-channels': 'shares', 'zhihu': 'collects', 'wechat-oa': 'shares'}
LABELS = {'views': '播放/阅读', 'likes': '点赞/赞同', 'comments': '评论', 'collects': '收藏', 'shares': '分享',
          'impressions': '曝光', 'completions': '完播次数', 'averageWatchSeconds': '平均观看秒数',
          'durationSeconds': '视频长度秒数', 'followersAttributed': '作品归因新增关注', 'coins': '投币', 'danmaku': '弹幕'}
_QUESTION = re.compile(r'[?？]|怎么|如何|哪里|哪种|为什么|能否|可以吗|求教程|求链接')


def metric(content, key):
    value = (content.get('advancedMetrics') or {}).get(key) if key in ADVANCED_METRICS else (content.get('metrics') or {}).get(key)
    try:
        return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None
    except OverflowError:
        return None


def _date(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except (ValueError, TypeError, AttributeError):
        return None


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:20]


def _cohort_key(content):
    reasons = []
    period, fmt, paid = content.get('period', 'unknown'), content.get('format', 'unknown'), content.get('paid')
    published, observed = _date(content.get('publishedAt')), _date(content.get('snapshotAt'))
    if period not in ('lifetime', '24h', '7d', '30d'):
        reasons.append('统计窗口未知')
    if not fmt or fmt == 'unknown':
        reasons.append('内容形式未知')
    if type(paid) is not bool:
        reasons.append('投放状态未知')
    if published is None:
        reasons.append('缺少有效发布时间')
    if observed is None:
        reasons.append('缺少有效观察时间')
    age = None
    if published is not None and observed is not None:
        elapsed = (observed - published).total_seconds()
        if elapsed < 0:
            reasons.append('观察时间早于发布时间')
        else:
            age = int(elapsed // 86400)
    if reasons:
        return None, reasons
    # Timed observations require the same endpoint; cumulative observations use whole-day age.
    endpoint = observed.isoformat() if period != 'lifetime' else None
    return (period, age, fmt, paid, endpoint), []


def _capabilities(contents, comparable):
    checks = [
        ('title', '标题承诺是否清楚、与内容交付是否一致？', ['实际标题', '正文或逐字稿'],
         lambda c: c.get('title') not in ('', '未提供标题', None) and bool(c.get('body') or c.get('transcript')), '只能核对文字承诺，不推断点击率。'),
        ('structure', '正文或口播的开场、论证和结尾哪里可改？', ['实际正文或逐字稿'],
         lambda c: bool(c.get('body') or c.get('transcript')), '没有画面、音频或时间码时不能评价剪辑、语速或前三秒留存。'),
        ('cover', '封面文字是否可读、与标题是否一致？', ['封面文字/OCR'],
         lambda c: bool(c.get('coverText')), '这里只检查已提供文字，不评价实际图片配色、字号或构图。'),
        ('comments', '读者反复追问什么，可做什么答疑题材？', ['真实评论原文'],
         lambda c: bool(c.get('comments')), '评论样本可能经过筛选；重复评论不等于独立人数或需求规模。'),
        ('reach', '曝光与播放/阅读是否有可核对的衔接？', ['曝光次数', '播放/阅读次数', '同一窗口定义'],
         lambda c: metric(c, 'impressions') is not None and metric(c, 'views') is not None and c.get('period') != 'unknown', '播放次数不必然等于封面点击次数；不得改名为点击率。'),
        ('watch', '完播或观看时长能否辅助检查视频结构？', ['平台定义的完播次数/平均观看秒数', '播放次数', '视频长度秒数'],
         lambda c: metric(c, 'durationSeconds') not in (None, 0) and metric(c, 'views') not in (None, 0) and (metric(c, 'completions') is not None or metric(c, 'averageWatchSeconds') is not None), '需核对平台分母定义及同长度条件；不输出观看质量的优劣排名。'),
        ('interaction', '收藏、评论或分享在同条件作品中有什么差异？', ['互动事件次数', '播放/阅读次数', '可比组'],
         lambda c: c['id'] in comparable and metric(c, 'views') not in (None, 0) and all(metric(c, k) is not None for k in ('likes', 'comments', 'collects', 'shares')), '每百次观看互动事件不是独立互动人数或转化率；缺任一事件计数不补零。'),
        ('followers', '这篇实际带来了多少平台归因关注？', ['作品归因新增关注'],
         lambda c: metric(c, 'followersAttributed') is not None, '账号净增粉丝不能代替单篇归因新增关注，也不证明内容改动的因果。'),
    ]
    total = len(contents)
    return [{'id': ident, 'question': question, 'required': required, 'available': sum(bool(check(c)) for c in contents),
             'total': total, 'status': 'available' if total and all(check(c) for c in contents) else 'partial' if any(check(c) for c in contents) else 'needs_data',
             'limitation': limitation} for ident, question, required, check, limitation in checks]


def _definitions():
    result = [{'key': key, 'label': label, 'unit': '秒' if key in ('averageWatchSeconds', 'durationSeconds') else '次',
               'formula': '平台原生观察值，保留原始定义与统计窗口',
               'limitation': '缺失为 null；不同平台或不同原生定义不可直接排名。'} for key, label in LABELS.items()]
    result.extend([
        {'key': 'interactionEventsPer100Views', 'label': '每百次观看互动事件', 'unit': '事件/百次观看',
         'formula': '100 × Σ(点赞/赞同 + 评论 + 收藏 + 分享) ÷ Σ播放/阅读；只含五项同时完整的同组作品',
         'limitation': '事件可重复，不是独立人数、互动转化率或算法权重；分母零时为 null。'},
        {'key': 'completionRatio', 'label': '完播次数/播放次数', 'unit': '比值', 'formula': '平台完播次数 ÷ 对应定义的播放次数',
         'limitation': '仅在平台分母定义已核对时使用；不得从视频长度推算完播。'},
    ])
    return result


def _event_rate(contents):
    valid = [c for c in contents if all(metric(c, key) is not None for key in ('views', 'likes', 'comments', 'collects', 'shares'))]
    if len(valid) != len(contents) or not valid:
        return None
    try:
        denominator = math.fsum(metric(c, 'views') for c in valid)
        numerator = math.fsum(metric(c, key) for c in valid for key in ('likes', 'comments', 'collects', 'shares'))
        value = numerator / denominator * 100 if denominator > 0 else None
        return value if value is not None and math.isfinite(value) else None
    except (OverflowError, ZeroDivisionError):
        return None


def build_professional(platform, account_id, contents):
    by_id = {c['id']: c for c in contents}
    groups, excluded = defaultdict(list), []
    for content in contents:
        key, reasons = _cohort_key(content)
        if reasons:
            excluded.append({'id': content['id'], 'reasons': reasons})
        else:
            groups[key].append(content['id'])
    cohorts = []
    for key, ids in sorted(groups.items(), key=lambda pair: str(pair[0])):
        period, age, fmt, paid, endpoint = key
        if len(ids) < 2:
            excluded.extend({'id': ident, 'reasons': ['缺少同平台/账号/形式/窗口/投放状态/整日年龄的另一篇作品']} for ident in ids)
            continue
        cohorts.append({'id': _digest([platform, account_id, key]), 'label': f'{fmt} · {period} · 发布后第 {age} 整日 · {"投放" if paid else "自然"}' + (f' · 截至 {endpoint}' if endpoint else ''),
                        'contentIds': sorted(ids), 'period': period, 'ageDays': age, 'format': fmt, 'paid': paid})
    comparable = {ident for cohort in cohorts for ident in cohort['contentIds']}
    stamps = sorted(c['snapshotAt'] for c in contents if _date(c.get('snapshotAt')) is not None)
    candidates = []
    tags = sorted({tag for c in contents for tag in c.get('tags', [])})
    for tag in tags:
        ids = sorted(c['id'] for c in contents if tag in c.get('tags', []))
        if len(ids) >= 2:
            candidates.append(('tag', tag, ids))
    questions = defaultdict(set)
    for content in contents:
        for comment in content.get('comments', []):
            if _QUESTION.search(comment):
                question = re.sub(r'\s+', '', comment).rstrip('?？!！。')
                if question:
                    questions[question].add(content['id'])
    candidates.extend(('comment_question', q, sorted(ids)) for q, ids in sorted(questions.items()))
    topics = []
    metric_key = PRIMARY_METRICS[platform]
    version = [[i, by_id[i].get('snapshotAt'), by_id[i].get('period'), by_id[i].get('metrics'), by_id[i].get('advancedMetrics'),
                by_id[i].get('publishedAt'), by_id[i].get('format'), by_id[i].get('paid'), by_id[i].get('tags'), by_id[i].get('comments')] for i in sorted(by_id)]
    version_hash = _digest(version)
    review = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(timespec='seconds')
    for kind, label, evidence_ids in candidates[:30]:
        selected = set(evidence_ids)
        eligible = []
        for cohort in cohorts:
            members = [by_id[i] for i in cohort['contentIds'] if i in selected]
            baseline = [by_id[i] for i in cohort['contentIds'] if i not in selected]
            if len(members) >= 2:
                eligible.append((cohort, members, baseline))
        eligible.sort(key=lambda value: (-len(value[1]), -len(value[2]), value[0]['id']))
        chosen = eligible[0] if eligible else None
        value = baseline_value = None
        counterexamples = []
        period = None
        status = 'editorial'
        missing = sum(any(metric(by_id[i], k) is None for k in ('views', 'likes', 'comments', 'collects', 'shares')) for i in evidence_ids)
        comparison = '尚无满足条件的同组比较；只作为编辑候选。'
        limitations = ['只覆盖所选账号已导入作品；标签分组可重叠。', '题材与表现的关系是待验证假设，不是算法规则、因果或增长预测。']
        if chosen:
            cohort, members, baseline = chosen
            period = cohort['period']
            value = _event_rate(members)
            baseline_value = _event_rate(baseline) if len(baseline) >= 2 else None
            counterexamples = [c['id'] for c in baseline]
            status = 'exploratory' if value is not None and baseline_value is not None and len(baseline) >= 2 else 'needs_data'
            comparison = f'{cohort["label"]}；题材组 {len(members)} 篇（' + '、'.join(c['id'] for c in members) + f'），同组其他题材 {len(baseline)} 篇。两组均以合计事件数除以合计观看次数。'
            if len(baseline) < 2:
                limitations.append('同组其他题材不足 2 篇，不生成稳定的效果比较。')
            if value is None or baseline_value is None:
                limitations.append('互动计数或播放/阅读缺失，或合计观看次数为零；无法计算比较值。')
        else:
            limitations.append('发布时间、形式、窗口、投放状态或作品年龄不足以建立同条件比较。')
        if kind == 'comment_question':
            limitations.append('按去空格和句尾标点精确归并评论；不推断独立提问人数或全部受众需求。')
        # Topic identity includes all supporting observations, so stale saves fail.
        topics.append({'id': _digest([platform, account_id, kind, label, version_hash]), 'label': label, 'kind': kind, 'status': status,
                       'evidenceIds': evidence_ids, 'counterexampleIds': counterexamples, 'sampleCount': len(evidence_ids), 'totalCount': len(contents),
                       'metric': metric_key, 'metricLabel': '每百次观看互动事件（点赞/赞同、评论、收藏、分享合计）',
                       'value': value, 'baselineValue': baseline_value, 'period': period, 'comparison': comparison, 'missingCount': missing,
                       'observation': f'{len(evidence_ids)} 篇作品包含' + ('实际标签' if kind == 'tag' else '实际评论问题') + f'“{label}”；引用范围为当前平台和账号的导入样本。',
                       'hypothesis': f'下一篇可验证“{label}”能否回应当前样本中的具体读者问题；替代解释包括作品年龄、受众、投放和外部流量。',
                       'action': f'围绕“{label}”制作一个明确回答，只调整选题角度一个变量；标题、长度和发布条件尽量保持一致，并提前登记 {LABELS[metric_key]} 为主观察指标。',
                       'reviewAt': review, 'stopRule': '发布后 7 天采集真实同口径观察；样本不足、窗口不齐、缺分母或投放条件变化时停止效果判断，保留编辑复盘。',
                       'limitations': limitations})
    return {'scope': {'platform': platform, 'accountId': account_id}, 'capabilities': _capabilities(contents, comparable),
            'quality': {'total': len(contents), 'comparable': len(comparable), 'excluded': sorted(excluded, key=lambda item: item['id']),
                        'observedFrom': stamps[0] if stamps else None, 'observedTo': stamps[-1] if stamps else None},
            'metricDefinitions': _definitions(), 'cohorts': cohorts, 'topics': topics}

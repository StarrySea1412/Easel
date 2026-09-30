"""Evidence-only presentation for existing multi-platform account collectors.

No model calls, synthetic metrics, cached account mixing, or guessed time windows.
"""
from __future__ import annotations

from datetime import datetime
import math
import re
from urllib.parse import urlsplit

PLATFORMS = {
    'douyin': ('抖音创作者中心', 'https://creator.douyin.com/creator-micro/home', '首页近 7 日指标', ('douyin.com',)),
    'kuaishou': ('快手创作者服务平台', 'https://cp.kuaishou.com/profile', '页面当前展示周期（未返回起止日期）', ('kuaishou.com',)),
    'zhihu': ('知乎创作中心', 'https://www.zhihu.com/creator/analytics', '页面当前展示周期（累计切换可能受页面状态影响）', ('zhihu.com',)),
    'weixin-channels': ('视频号助手', 'https://channels.weixin.qq.com/platform', '首页当前数据（未返回起止日期）', ('channels.weixin.qq.com',)),
    'bilibili': ('B站创作中心接口', 'https://member.bilibili.com/platform/home', '累计指标；增量周期由平台接口提供，未核定起止日期', ('bilibili.com',)),
    'wechat-oa': ('微信公众号后台', 'https://mp.weixin.qq.com/', '各指标按标签所示周期；作品仅覆盖当前返回的发表记录', ('mp.weixin.qq.com',)),
}
OVERVIEW = (('followers', '粉丝 / 关注者'), ('likes', '获赞'), ('following', '关注'), ('posts', '作品'))


def _metric_names(platform):
    return (('views', '阅读' if platform in ('zhihu', 'wechat-oa') else '播放'),
            ('likes', '赞同' if platform == 'zhihu' else '点赞'),
            ('collects', '收藏'), ('comments', '评论'), ('shares', '分享'))


def _number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def _timestamp(value):
    if _number(value) is not None and value > 0:
        return int(value)
    if isinstance(value, str) and value:
        try:
            return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp())
        except (ValueError, OverflowError):
            pass
    return None


def safe_link(value, hosts):
    if not isinstance(value, str):
        return ''
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ''
        if parsed.scheme == 'https' and not parsed.username and not parsed.password \
                and any(host == root or host.endswith('.' + root) for root in hosts):
            return value
    except ValueError:
        pass
    return ''


def _article_evidence(items):
    """Keep the separate analytics source separate from publish-page metrics."""
    return [{'title': str(item.get('title') or '未提供标题')[:200],
             'source': '公众号文章分析列表', 'period': '统计窗口未核验',
             'metrics': [{'label': label, 'value': _number(values.get(key))}
                         for key, label in (('views', '阅读人数'), ('shares', '分享人数'))
                         if _number(values.get(key)) is not None]}
            for item in items if isinstance(item, dict)
            for values in [item.get('metrics') if isinstance(item.get('metrics'), dict) else {}]]


def build_analysis(platform: str, data: dict) -> dict:
    label, source_url, period, hosts = PLATFORMS[platform]
    logged_in = data.get('loggedIn') is True
    overview = [{'key': key, 'label': label, 'value': _number(data.get(key)) if logged_in else None}
                for key, label in OVERVIEW]
    if platform == 'zhihu':
        overview[1]['label'] = '赞同'
    metrics = []
    for item in (data.get('metrics') or []) if logged_in else []:
        if not isinstance(item, dict) or not isinstance(item.get('label'), str):
            continue
        value = item.get('value')
        if _number(value) is not None or (isinstance(value, str) and re.fullmatch(r'[+\-]?\d[\d,.]*\s*[万亿wWkK千%]?', value.strip())):
            metric = {'label': item['label'][:80], 'value': str(value),
                      'comparison': str(item.get('vs') or '')[:80]}
            coverage = item.get('coverage')
            if isinstance(coverage, dict):
                known, sample = _number(coverage.get('known_records')), _number(coverage.get('sample_records'))
                metric['coverage'] = {'knownRecords': known, 'sampleRecords': sample,
                                      'complete': coverage.get('complete') is True and known is not None and known == sample}
            window = item.get('window')
            if isinstance(window, dict):
                metric['window'] = {'kind': str(window.get('kind') or 'unknown'),
                                    'from': window.get('actual_from'), 'to': window.get('actual_to'),
                                    'accountComplete': window.get('account_complete') is True,
                                    'aggregation': str(window.get('aggregation') or ''),
                                    'missingDays': _number(window.get('missing_days'))}
            metrics.append(metric)
    notes = []
    for item in (data.get('notes') or []) if logged_in else []:
        if not isinstance(item, dict):
            continue
        link = safe_link(item.get('url'), hosts)
        management_link = bool(link and any(part in urlsplit(link).path for part in ('/manage', '/platform', '/creator-micro/content')))
        values = item.get('metrics') if isinstance(item.get('metrics'), dict) else {}
        analytics_source = platform == 'wechat-oa' and item.get('source') == 'appmsganalysis.article_list'
        names = _metric_names(platform)
        if analytics_source:
            names = tuple((key, {'views': '阅读人数', 'shares': '分享人数'}.get(key, name)) for key, name in names)
        actual = [(name, _number(values.get(key))) for key, name in names]
        published_at = _timestamp(item.get('publish'))
        missing = []
        if analytics_source:
            missing.append('来源：公众号文章分析列表；统计窗口未核验，人数不与发表列表阅读量合并')
        if not link:
            missing.append('未提供可核验的平台原文链接')
        if management_link:
            missing.append('链接指向作品管理页，平台未提供独立原文链接')
        if not any(value is not None for _, value in actual):
            missing.append('未提供结构化逐篇指标，不能据此进行作品排名或效果归因')
        if published_at is None:
            missing.append('未提供可靠发布时间')
        missing_metrics = [name for name, value in actual if value is None]
        if missing_metrics:
            missing.append('本次未返回：' + '、'.join(missing_metrics) + '；不代表数值为 0 或平台不支持')
        notes.append({'title': str(item.get('title') or '未提供标题')[:200], 'url': link,
                      'linkLabel': '打开管理页' if management_link else '查看原作品',
                      'stat': str(item.get('stat') or '')[:500], 'publish': str(item.get('publish') or '')[:100],
                      'metrics': [{'label': name, 'value': value} for name, value in actual if value is not None],
                      'publishedAt': published_at, 'hasOriginalLink': bool(link and not management_link),
                      'analyticsEvidence': _article_evidence(item.get('analytics_evidence') or []) if platform == 'wechat-oa' else [],
                      'missingFields': missing})
    count = sum(item['value'] is not None for item in overview) + len(metrics)
    missing = [item['label'] for item in overview if item['value'] is None]
    if not notes:
        missing.append('本次没有返回作品明细，不能据此判断账号没有作品')
    if not metrics:
        missing.append('本次没有返回平台区间指标')
    quality = {
        'returnedNotes': len(notes),
        'notesWithMetrics': sum(bool(note['metrics']) for note in notes),
        'structuredMetricValues': sum(len(note['metrics']) for note in notes),
        'notesMissingPublishTime': sum(note['publishedAt'] is None for note in notes),
        'notesMissingOriginalLink': sum(not note['hasOriginalLink'] for note in notes),
        'periodKnown': False,
        'sampleScope': 'returned_only',
        'canComparePerformance': False,
        'level': 'no_content' if not notes else 'metrics_available' if any(note['metrics'] for note in notes) else 'records_only',
        'comparisonReason': '尚未核验逐篇指标的统计起止日期、作品发布时长和完整采集范围，暂不进行效果排名或增长比较。',
    }
    windows = []
    if logged_in and platform == 'wechat-oa':
        for key, window in (data.get('period_windows') or {}).items():
            if not isinstance(window, dict):
                continue
            windows.append({'label': {'day': '最近 1 日', 'week': '最近 7 日', 'month': '最近 30 日',
                                      'year': '最近 365 日', 'last': '最近返回记录'}.get(key, key),
                            'from': window.get('actual_from'), 'to': window.get('actual_to'),
                            'observedDays': _number(window.get('observed_days')),
                            'missingDays': _number(window.get('missing_days')),
                            'complete': window.get('calendar_complete') is True})
    unmatched = _article_evidence(data.get('unmatched_article_evidence') or []) if logged_in and platform == 'wechat-oa' else []
    suggestions = []
    if logged_in:
        for item in metrics:
            if any(word in item['label'] for word in ('评论', '分享', '收藏')):
                coverage_note = ''
                if item.get('coverage') and not item['coverage']['complete']:
                    coverage_note = '（部分合计，字段或日期覆盖不完整）'
                suggestions.append({'title': f"围绕「{item['label']}」安排一次内容实验",
                                    'reason': f"本次平台返回：{item['label']} {item['value']}{coverage_note}；口径：{period}。",
                                    'action': '从已发布作品中挑选同主题内容，调整一个互动或信息表达方式；下次按相同时间窗口复查。当前数值不能证明某种写法有效。'})
                break
        if notes:
            suggestions.append({'title': '先复盘这次采集到的作品',
                                'reason': f'当前只有 {len(notes)} 条作品记录，部分平台只返回最近一页；不能代表全部作品。',
                                'action': '打开下方作品核对主题、发布时间与平台数据，再选择一个主题继续测试。缺少逐篇指标时不做爆款排序。'})
        if count:
            suggestions.append({'title': '建立可比较的账号基线',
                                'reason': f'本次取得 {count} 项数值指标；尚未建立经账号归属核验的历史比较窗口。',
                                'action': '记录当前平台和账号，在相同统计周期再次采集后比较；当前不报告日、周、月增长率。'})
    # Successful transport is not evidence of comparable content performance.
    return {'status': 'logged_out' if not logged_in else 'empty' if not count and not notes else 'partial',
            'source': {'label': label, 'url': source_url}, 'fetchedAt': _timestamp(data.get('fetched_at')),
            'period': period, 'overview': overview, 'metrics': metrics, 'notes': notes,
            'coverage': {'notes': len(notes), 'numericMetrics': count}, 'quality': quality, 'missingFields': missing,
            'periodWindows': windows, 'unmatchedEvidence': unmatched,
            'suggestions': suggestions,
            'limitations': ['仅展示本次登录会话返回的数据；切换账号后需重新采集。',
                            '不同平台的统计口径和时间窗口不同，数值不直接横向比较。',
                            '平台级旧快照未确认属于同一账号，不用于本人增长结论。']}

"""Account-scoped, local evidence workbench. No model or platform-success claims.

SQLite transactions preserve imports and experiment baselines across restarts.
Metrics are observations, never interchangeable platform performance scores.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from content_analysis_platforms import platform_profile, platform_diagnostics, VERSION
from content_analysis_professional import ADVANCED_METRICS, build_professional, metric as metric_value

PLATFORMS = ('xiaohongshu', 'douyin', 'kuaishou', 'zhihu', 'weixin-channels', 'bilibili', 'wechat-oa')
METRICS = ('views', 'likes', 'comments', 'collects', 'shares')
REVIEW_RULE_VERSION = 2
METHOD = '仅分析所选账号已导入的作品样本；指标不跨平台比较，不把缺失补零，不把相关性当因果。材料分析覆盖正文、真实评论、封面文字与逐字稿；只引用实际提供的文字，不推断图像、视频画面或算法偏好。'


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def timestamp(value, *, default=None):
    if value is None or value == '':
        return default
    try:
        if type(value) in (int, float):
            dt = datetime.fromtimestamp(value, timezone.utc)
        elif isinstance(value, str):
            dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if dt.tzinfo is None:
                raise ValueError('日期必须包含时区，例如 2026-09-30T08:00:00+08:00')
        else:
            raise ValueError('日期格式无效')
        return dt.astimezone(timezone.utc).isoformat(timespec='seconds')
    except (ValueError, OverflowError, OSError) as exc:
        raise ValueError(f'日期格式无效或缺少时区：{value}') from exc


def scope(platform, account_id):
    if platform not in PLATFORMS:
        raise ValueError('不支持的平台')
    if not isinstance(account_id, str) or not account_id.strip() or len(account_id) > 200:
        raise ValueError('请提供 1–200 字符的明确账号 ID')
    return platform, account_id.strip()


def text(value, limit=20000):
    if value is None:
        return ''
    if not isinstance(value, str):
        raise ValueError('文字字段必须是字符串')
    if len(value) > limit:
        raise ValueError(f'文字字段超过 {limit} 字符')
    return value.strip()


def normalize_metrics(raw, keys, field):
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ValueError(f'{field} 必须为对象')
    result = {}
    for key in keys:
        value = raw.get(key)
        try:
            valid = value is None or (type(value) in (int, float) and math.isfinite(value) and value >= 0)
        except OverflowError:
            valid = False
        if not valid:
            raise ValueError(f'{key} 必须为非负有限数值或 null；次数不得输入百分比或统计文案')
        result[key] = value
    return result


def normalize(item, account_id, observed_at):
    if not isinstance(item, dict):
        raise ValueError('作品必须是对象')
    if item.get('accountId') not in (None, account_id):
        raise ValueError('作品账号与所选账号不符')
    ident = text(item.get('id'), 300)
    if not ident:
        raise ValueError('每篇作品必须有稳定 id；不能用标题合并作品')
    title = text(item.get('title'), 500)
    body = text(item.get('body'), 100000)
    cover_text = text(item.get('coverText'), 5000)
    transcript = text(item.get('transcript'), 100000)
    comments = item.get('comments', [])
    if not isinstance(comments, list) or len(comments) > 1000:
        raise ValueError('comments 必须为最多 1000 条真实评论文字的数组')
    comments = [value for value in (text(comment, 5000) for comment in comments if comment) if value]
    tags = item.get('tags', [])
    if not isinstance(tags, list) or len(tags) > 40:
        raise ValueError('tags 必须为最多 40 个文字标签的数组')
    tags = list(dict.fromkeys(value for value in (text(tag, 60) for tag in tags if tag) if value))
    metrics = normalize_metrics(item.get('metrics'), METRICS, 'metrics')
    advanced = normalize_metrics(item.get('advancedMetrics'), ADVANCED_METRICS, 'advancedMetrics')
    url = text(item.get('url'), 2000)
    if url:
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('作品链接必须是无凭据的 HTTPS 链接')
    period = item.get('period', 'unknown')
    if period not in ('lifetime', 'unknown', '24h', '7d', '30d'):
        raise ValueError('period 仅接受 lifetime / unknown / 24h / 7d / 30d')
    paid = item.get('paid')
    if paid is not None and type(paid) is not bool:
        raise ValueError('paid 必须为布尔值或 null')
    return {'id': ident, 'title': title or '未提供标题', 'body': body, 'tags': tags,
            'comments': comments, 'coverText': cover_text, 'transcript': transcript,
            'format': text(item.get('format'), 40) or 'unknown', 'url': url,
            'publishedAt': timestamp(item.get('publishedAt')), 'snapshotAt': timestamp(item.get('snapshotAt'), default=observed_at),
            'period': period, 'paid': paid, 'metrics': metrics, 'advancedMetrics': advanced}


def diagnostics(content):
    result = []
    def add(key, dimension, observation, evidence, action, limitation='这是基于文字材料的编辑建议，不代表效果原因或增长预测。'):
        result.append({'id': f'{content["id"]}:{key}', 'dimension': dimension, 'observation': observation,
                       'evidence': evidence, 'action': action, 'limitation': limitation})
    title, body = content['title'], content['body']
    if title != '未提供标题':
        add('title', '标题与承诺', f'标题共 {len(title)} 个字符，应与正文实际交付一致。', title,
            '写出目标读者、具体问题和正文能够证明的收益；保留原版，再做一个更明确的候选标题，单次只改一项。')
        if re.search(r'必看|震惊|绝对|百分百|100%|保证|暴涨|稳赚', title):
            add('promise', '标题与承诺', '标题包含强承诺词，需要正文证据支持。', title,
                '将无法验证的绝对承诺替换为适用条件、样本范围或具体经验，核对标题与正文是否一致。')
    if body:
        paragraphs = [p.strip() for p in re.split(r'\n\s*\n|\n', body) if p.strip()]
        add('opening', '开头与读者问题', f'已提供正文 {len(body)} 字、{len(paragraphs)} 个文本段落。', paragraphs[0][:260],
            '检查第一段是否直接回答“这与我有什么关系”；尝试先写具体情境、遇到的问题与本文提供的方法。')
        longest = max(paragraphs, key=len)
        if len(longest) > 250:
            add('structure', '正文结构', f'最长段落为 {len(longest)} 字，可评估阅读负担。', longest[:260],
                '按一个段落一个观点拆分：结论 → 例子或证据 → 操作步骤；阈值仅用于编辑提醒，不是平台标准。')
        if not re.search(r'例如|比如|案例|数据|来源|步骤|第一|1[.、）]', body):
            add('support', '证据与可操作性', '规则未识别到常见举例或步骤标记，需人工检查。', body[:260],
                '为核心观点补一个可核验实例、来源或步骤；自动规则可能漏识别隐含案例，请保留人工判断。')
        add('ending', '结尾与行动', '可针对结尾设置一个具体且容易回答的问题。', paragraphs[-1][:260],
            '围绕正文里的真实选择提出一个问题，或给出下一步操作；不要把评论邀请等同于一定增加互动。')
    else:
        add('missing-body', '材料完整性', '没有正文，暂不进行正文结构诊断。', f'作品 ID：{content["id"]}',
            '补充实际正文或视频逐字稿，再检查开头、论证、段落和结尾。', '未读取图片、视频、评论或音频，不能评价这些材料。')
    cover = content.get('coverText') or ''
    if cover:
        add('cover', '封面文字', f'提供的封面文案有 {len(cover)} 字。' + ('文字较多，可评估层级和手机端阅读负担。' if len(cover) > 35 else '可作为单一信息承诺与标题一起核对。'),
            cover[:300], f'把“{cover[:60]}”中的核心信息放在主层级，细节放副标题；检查是否与“{title[:60]}”及正文交付一致。',
            '仅分析用户提供的封面文字/OCR；35 字是编辑检查阈值，不是平台标准。未检查实际图像的字号、配色、遮挡或构图。')
    transcript = content.get('transcript') or ''
    if transcript:
        segments = [segment.strip() for segment in re.split(r'\n|[。！？!?]', transcript) if segment.strip()]
        if segments:
            add('script-opening', '视频逐字稿', f'逐字稿 {len(transcript)} 字，按句界识别 {len(segments)} 个片段。', segments[0][:260],
                f'开场“{segments[0][:60]}”先明确对象和问题，再安排演示或证据；标记每句需要的镜头素材后交给人工核对。',
                '未获取音频、画面或逐字时间码，不能计算时长、语速、前三秒留存或完播率。')
        else:
            add('script-empty', '材料完整性', '逐字稿只有标点或空白，尚无可分析的语句。', transcript[:260],
                '补充实际口播文字后再检查开场与推进。', '不根据空白或标点推断视频内容、时长或表现。')
        if len(segments) >= 3:
            add('script-flow', '逐字稿推进', '可检查开场承诺在结尾是否得到回答。', f'开场：{segments[0][:120]}\n结尾：{segments[-1][:120]}',
                '在中段放入关键证明或操作，结尾回到开场问题；删除与主问题无关的句子，保留支撑结论的限定条件。')
    comments = content.get('comments') or []
    if comments:
        questions = [comment for comment in comments if re.search(r'[?？]|怎么|如何|哪里|哪种|为什么|能否|可以吗|求教程|求链接', comment)]
        counts = Counter(re.sub(r'\s+', '', comment).rstrip('?？!！。') for comment in questions)
        add('comment-coverage', '评论需求', f'提供 {len(comments)} 条评论，其中规则识别 {len(questions)} 条提问或求助；未提供作者 ID，不能推断独立人数。',
            '\n'.join(f'评论 {i + 1}：{q}' for i, q in [(i, q) for i, q in enumerate(comments) if q in questions][:5]) or '\n'.join(comments[:3]),
            '优先回复可具体回答的问题，并记录回复后的追问；评论样本可能经过筛选，不能视为全部受众意见。')
        for index, (question, count) in enumerate(counts.most_common(3)):
            add(f'question-{index}', '读者问题与选题', f'这一问题在提供的评论中出现 {count} 次（按去空格/句尾标点精确归并）。', question,
                f'围绕“{question[:100]}”单独制作回答：先给直接答案，再列适用条件、具体步骤和一个可验证实例；暂不外推需求规模。')
    if not cover and not transcript:
        add('visual', '封面与视频', '没有封面文字或逐字稿，当前未进行图像识别或音视频理解。', f'作品 ID：{content["id"]}',
            '补充真实封面文字/OCR或视频逐字稿，分别检查信息承诺、开场问题、推进与结尾；视觉呈现仍需实际图像。', '无视觉材料证据，不输出配色、构图、前三秒画面或完播原因。')
    return result


def draft(content):
    questions = [comment for comment in content.get('comments', []) if re.search(r'[?？]|怎么|如何|为什么|能否', comment)]
    question = questions[0][:160] if questions else f'读者为什么需要了解“{content["title"][:80]}”？（待人工确认）'
    topic = content['tags'][0] if content['tags'] else content['title'][:80]
    return {'audienceQuestion': question, 'titleOptions': [f'{topic}：先回答这个问题', f'关于{topic}，一个具体问题的分步解答'],
            'outline': [f'读者问题：{question}', '直接回答：补充经核实的结论及适用条件，不编造效果或数据。',
                        '具体方法：列出实际可执行的步骤及所需材料。', '证据与实例：引用真实经历、演示或来源，并说明局限。',
                        '结尾：回到读者问题，给出下一步操作，并邀请补充具体使用情境。'],
            'evidenceIds': [content['id']], 'note': '基于已有主题/评论的可编辑创作起点，非模型生成的完整成稿；事实、标题承诺及素材仍需核实。'}


class Store:
    def __init__(self, root: Path):
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / 'content-analysis.sqlite3'
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS accounts (platform TEXT, account_id TEXT, data TEXT NOT NULL, PRIMARY KEY(platform, account_id))')
            db.execute('CREATE TABLE IF NOT EXISTS contents (platform TEXT, account_id TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(platform, account_id,id))')
            db.execute('CREATE TABLE IF NOT EXISTS snapshots (platform TEXT, account_id TEXT, content_id TEXT, hash TEXT, data TEXT NOT NULL, PRIMARY KEY(platform,account_id,content_id,hash))')
            db.execute('CREATE TABLE IF NOT EXISTS experiments (platform TEXT, account_id TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(platform,account_id,id))')
            db.execute('CREATE TABLE IF NOT EXISTS ai_reviews (platform TEXT, account_id TEXT, content_id TEXT, source_hash TEXT, data TEXT NOT NULL, PRIMARY KEY(platform,account_id,content_id))')

            db.execute('CREATE TABLE IF NOT EXISTS account_insights (platform TEXT, account_id TEXT, source_hash TEXT, data TEXT NOT NULL, PRIMARY KEY(platform,account_id))')
            db.execute('CREATE TABLE IF NOT EXISTS sync_states (platform TEXT, request_account_id TEXT, updated_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(platform,request_account_id))')

    def connect(self):
        return sqlite3.connect(self.path, timeout=15)

    def accounts(self):
        with self.connect() as db:
            return [json.loads(row[0]) for row in db.execute('SELECT data FROM accounts ORDER BY platform,account_id')]

    def sync_state(self, platform, account_id=None):
        scope(platform, account_id or '__discover__')
        with self.connect() as db:
            row = db.execute('SELECT data FROM sync_states WHERE platform=? AND request_account_id=?', (platform, account_id or '')).fetchone()
        return json.loads(row[0]) if row else None

    def save_sync_state(self, platform, request_account_id, state):
        scope(platform, request_account_id or '__discover__')
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO sync_states VALUES(?,?,?,?)',
                       (platform, request_account_id or '', now(), json.dumps(state, ensure_ascii=False)))

    def ingest(self, payload, *, identity='user_declared'):
        platform, account_id = scope(payload.get('platform'), payload.get('accountId'))
        items = payload.get('contents')
        if not isinstance(items, list) or not 1 <= len(items) <= 2000:
            raise ValueError('每次导入需包含 1–2000 篇作品')
        observed_at = now()
        contents = [normalize(item, account_id, observed_at) for item in items]
        if len({c['id'] for c in contents}) != len(contents):
            raise ValueError('本次导入包含重复作品 id，请合并后重试')
        name = text(payload.get('name'), 200) or account_id
        with self.connect() as db:
            for item, content in zip(items, contents):
                previous = db.execute('SELECT data FROM contents WHERE platform=? AND account_id=? AND id=?', (platform, account_id, content['id'])).fetchone()
                if previous:
                    old = json.loads(previous[0])
                    # A metric-only refresh must not erase manually supplied writing materials.
                    for key in ('title', 'body', 'tags', 'format', 'url', 'publishedAt', 'comments', 'coverText', 'transcript'):
                        if key not in item:
                            content[key] = old.get(key)
                    if 'metrics' not in item and 'advancedMetrics' not in item:
                        for key in ('metrics', 'snapshotAt', 'period', 'paid'):
                            content[key] = old[key]
                        content['advancedMetrics'] = {key: (old.get('advancedMetrics') or {}).get(key) for key in ADVANCED_METRICS}
                    elif all(content[key] == old.get(key) for key in ('snapshotAt', 'period', 'paid')):
                        # Only merge complementary metric blocks for the exact same observation.
                        if 'metrics' not in item:
                            content['metrics'] = old['metrics']
                        if 'advancedMetrics' not in item:
                            content['advancedMetrics'] = {key: (old.get('advancedMetrics') or {}).get(key) for key in ADVANCED_METRICS}
                content['identity'] = identity
                snapshot = {'contentId': content['id'], 'snapshotAt': content['snapshotAt'],
                            'period': content['period'], 'metrics': content['metrics'], 'paid': content['paid']}
                if any(value is not None for value in content['advancedMetrics'].values()):
                    snapshot['advancedMetrics'] = content['advancedMetrics']
                encoded = json.dumps(snapshot, ensure_ascii=False, sort_keys=True)
                digest = hashlib.sha256(encoded.encode()).hexdigest()
                db.execute('INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?,?)', (platform, account_id, content['id'], digest, encoded))
                # Older observations are preserved but never replace the newest metrics.
                if previous and old['snapshotAt'] > content['snapshotAt']:
                    continue
                db.execute('INSERT OR REPLACE INTO contents VALUES(?,?,?,?)', (platform, account_id, content['id'], json.dumps(content, ensure_ascii=False)))
            count = db.execute('SELECT COUNT(*) FROM contents WHERE platform=? AND account_id=?', (platform, account_id)).fetchone()[0]
            identities = {json.loads(r[0]).get('identity', 'user_declared') for r in db.execute('SELECT data FROM contents WHERE platform=? AND account_id=?', (platform, account_id))}
            account_identity = next(iter(identities)) if len(identities) == 1 else 'mixed'
            account = {'platform': platform, 'accountId': account_id, 'name': name, 'contentCount': count,
                       'lastImportedAt': observed_at, 'identity': account_identity}
            db.execute('INSERT OR REPLACE INTO accounts VALUES(?,?,?)', (platform, account_id, json.dumps(account, ensure_ascii=False)))
        return self.report(platform, account_id)

    def report(self, platform, account_id):
        platform, account_id = scope(platform, account_id)
        with self.connect() as db:
            row = db.execute('SELECT data FROM accounts WHERE platform=? AND account_id=?', (platform, account_id)).fetchone()
            if not row:
                raise LookupError('该账号尚未导入作品')
            account = json.loads(row[0])
            contents = [json.loads(r[0]) for r in db.execute('SELECT data FROM contents WHERE platform=? AND account_id=? ORDER BY id', (platform, account_id))]
            experiments = [json.loads(r[0]) for r in db.execute('SELECT data FROM experiments WHERE platform=? AND account_id=? ORDER BY id', (platform, account_id))]
            snapshots = [json.loads(r[0]) for r in db.execute('SELECT data FROM snapshots WHERE platform=? AND account_id=?', (platform, account_id))]
            reviews = {r[0]: (r[1], json.loads(r[2])) for r in db.execute('SELECT content_id,source_hash,data FROM ai_reviews WHERE platform=? AND account_id=?', (platform, account_id))}
            insight_row = db.execute('SELECT source_hash,data FROM account_insights WHERE platform=? AND account_id=?', (platform, account_id)).fetchone()
        source_hash = account_material_hash(contents)
        account_insights = json.loads(insight_row[1]) if insight_row and insight_row[0] == source_hash else None
        for content in contents:
            content['advancedMetrics'] = {key: (content.get('advancedMetrics') or {}).get(key) for key in ADVANCED_METRICS}
            content['diagnostics'] = diagnostics(content) + platform_diagnostics(platform, content)
            content['draft'] = draft(content)
            review = reviews.get(content['id'])
            content['aiReview'] = review[1] if review and review[0] == material_hash(content) else None
            content['snapshots'] = sorted([s for s in snapshots if s['contentId'] == content['id']], key=lambda s: s['snapshotAt'])
            for snapshot in content['snapshots']:
                snapshot['advancedMetrics'] = {key: (snapshot.get('advancedMetrics') or {}).get(key) for key in ADVANCED_METRICS}
        totals, coverage = summarize(contents)
        tags = sorted({tag for content in contents for tag in content['tags']})
        themes = []
        for tag in tags:
            members = [c for c in contents if tag in c['tags']]
            values, cov = summarize(members)
            themes.append({'tag': tag, 'count': len(members), 'contentIds': [c['id'] for c in members], 'metrics': values, 'coverage': cov,
                           'note': '标签可重叠；样本合计不代表主题因果优势，不同成熟度及统计周期不可直接排名。'})
        warnings = ['仅覆盖已导入作品，不代表账号全部作品；同口径样本合计不等于账号指标，未知或混合口径不加总。', '材料规则提供编辑检查，不是 AI 视觉诊断或效果归因。']
        if account['identity'] != 'live_verified':
            warnings.append('账号归属为用户声明，未经平台身份核验。')
        for key, label in [('publishedAt', '发布时间'), ('body', '正文材料')]:
            missing = sum(not c.get(key) for c in contents)
            if missing:
                warnings.append(f'{missing} 篇作品缺少{label}。')
        if any(c['period'] == 'unknown' for c in contents):
            warnings.append('部分作品统计窗口未知，不能做同龄效果比较。')
        return {'account': account, 'platformProfile': platform_profile(platform), 'accountInsights': account_insights, 'contents': contents, 'overview': {'contentCount': len(contents), 'metricCoverage': coverage,
                'totals': totals, 'lastImportedAt': account['lastImportedAt']}, 'themes': themes, 'experiments': experiments,
                'quality': {'identity': account['identity'], 'warnings': warnings}, 'methodology': METHOD,
                'professional': build_professional(platform, account_id, contents)}

    def experiment(self, payload, experiment_id=None):
        platform, account_id = scope(payload.get('platform'), payload.get('accountId'))
        report = self.report(platform, account_id)
        by_id = {c['id']: c for c in report['contents']}
        if experiment_id:
            existing = next((e for e in report['experiments'] if e['id'] == experiment_id), None)
            if existing is None:
                raise LookupError('所选账号下没有此实验')
            experiment = existing
            status = payload.get('status', experiment['status'])
            if status not in ('planned', 'running', 'reviewed'):
                raise ValueError('无效实验状态')
            experiment['status'] = status
            experiment['conclusion'] = text(payload.get('conclusion', experiment.get('conclusion')), 5000)
            if status == 'reviewed':
                observations = []
                baseline = {b['contentId']: b for b in experiment['baseline']}
                for ident in experiment['contentIds']:
                    content = by_id[ident]
                    value = metric_value(content, experiment['metric'])
                    base = baseline[ident]
                    cumulative = experiment['metric'] not in ('averageWatchSeconds', 'durationSeconds')
                    comparable = cumulative and content['period'] == base['period'] == 'lifetime' and content['paid'] == base.get('paid') and content['snapshotAt'] > base['snapshotAt']
                    delta = value - base['value'] if comparable and value is not None and base['value'] is not None else None
                    observations.append({'contentId': ident, 'snapshotAt': content['snapshotAt'], 'value': value, 'delta': delta,
                                         'comparable': comparable, 'note': '累计观测差值，不是改动的因果效果；负值可能来自平台回溯修正。' if comparable else '尚无同口径的新观测，或不支持累计差值。'})
                experiment['reviews'].append({'at': now(), 'observations': observations, 'note': experiment['conclusion']})
        else:
            ids = payload.get('contentIds')
            if not isinstance(ids, list) or not ids or any(not isinstance(i, str) or i not in by_id for i in ids):
                raise ValueError('实验必须关联所选账号的有效作品 ID')
            metric = payload.get('metric')
            if metric not in METRICS + ADVANCED_METRICS:
                raise ValueError('请指定支持的主指标')
            title, hypothesis, action = [text(payload.get(k), 2000) for k in ('title', 'hypothesis', 'action')]
            if not all((title, hypothesis, action)):
                raise ValueError('实验标题、假设和具体改动不能为空')
            experiment = {'id': uuid.uuid4().hex, 'title': title, 'hypothesis': hypothesis, 'action': action, 'metric': metric,
                          'contentIds': list(dict.fromkeys(ids)), 'reviewAt': timestamp(payload.get('reviewAt')), 'createdAt': now(),
                          'status': 'planned', 'conclusion': '', 'reviews': [], 'baseline': [
                              {'contentId': i, 'snapshotAt': by_id[i]['snapshotAt'], 'value': metric_value(by_id[i], metric),
                               'period': by_id[i]['period'], 'paid': by_id[i]['paid']} for i in dict.fromkeys(ids)]}
            supplied = payload.get('evidence')
            if supplied is not None:
                expected_scope = {'platform': platform, 'accountId': account_id}
                if not isinstance(supplied, dict) or supplied.get('scope') != expected_scope or not isinstance(supplied.get('topic'), dict):
                    raise ValueError('题材证据与当前平台/账号不符')
                topic = next((t for t in report['professional']['topics'] if t['id'] == supplied['topic'].get('id')), None)
                if topic is None or set(ids) != set(topic['evidenceIds']):
                    raise ValueError('题材证据已改变或作品范围不符，请重新读取当前报告')
                experiment['evidence'] = {'scope': expected_scope, 'topic': topic, 'capturedAt': now()}
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current = [json.loads(row[0]) for row in db.execute('SELECT data FROM contents WHERE platform=? AND account_id=? ORDER BY id', (platform, account_id))]
            if account_material_hash(current) != account_material_hash(report['contents']):
                raise ValueError('账号材料已更改，请重新读取报告后保存实验')
            db.execute('INSERT OR REPLACE INTO experiments VALUES(?,?,?,?)', (platform, account_id, experiment['id'], json.dumps(experiment, ensure_ascii=False)))
        return experiment

    def save_review(self, platform, account_id, content, review):
        platform, account_id = scope(platform, account_id)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT data FROM contents WHERE platform=? AND account_id=? AND id=?', (platform, account_id, content['id'])).fetchone()
            if not row or material_hash(json.loads(row[0])) != material_hash(content):
                raise ValueError('作品材料已更改，请重新发起深度解释')
            db.execute('INSERT OR REPLACE INTO ai_reviews VALUES(?,?,?,?,?)',
                       (platform, account_id, content['id'], material_hash(content), json.dumps(review, ensure_ascii=False)))

    def save_insights(self, platform, account_id, contents, result):
        platform, account_id = scope(platform, account_id)
        expected = account_material_hash(contents)
        with self.connect() as db:
            # Compare and write under one lock: concurrent imports cannot slip in between.
            db.execute('BEGIN IMMEDIATE')
            current = [json.loads(row[0]) for row in db.execute('SELECT data FROM contents WHERE platform=? AND account_id=? ORDER BY id', (platform, account_id))]
            if not current or account_material_hash(current) != expected:
                raise ValueError('账号材料已更改，请重新请求跨作品解读')
            db.execute('INSERT OR REPLACE INTO account_insights VALUES(?,?,?,?)',
                       (platform, account_id, expected, json.dumps(result, ensure_ascii=False)))


def account_material_hash(contents):
    values = [(c['id'], material_hash(c)) for c in sorted(contents, key=lambda c: c['id'])]
    return hashlib.sha256(json.dumps([VERSION, values], ensure_ascii=False).encode()).hexdigest()


def material_hash(content):
    selected = {k: content.get(k) for k in ('id', 'title', 'body', 'coverText', 'transcript', 'comments', 'metrics', 'period', 'tags', 'format', 'paid', 'snapshotAt', 'publishedAt', 'identity')}
    selected['advancedMetrics'] = {key: (content.get('advancedMetrics') or {}).get(key) for key in ADVANCED_METRICS}
    # Older stored interpretations did not pass the current material/quantity
    # checks. Preserve them in SQLite, but never expose them as current reviews.
    return hashlib.sha256(json.dumps([REVIEW_RULE_VERSION, selected], ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def summarize(contents):
    coverage = {key: sum(c['metrics'][key] is not None for c in contents) for key in METRICS}
    # Even partial sums are exposed with coverage; unlike rate/score no inferred denominator.
    totals = {}
    for key in METRICS:
        known = [c for c in contents if c['metrics'][key] is not None]
        periods = {c['period'] for c in known}
        totals[key] = None
        if known and len(periods) == 1 and 'unknown' not in periods:
            try:
                value = sum(c['metrics'][key] for c in known)
                totals[key] = value if math.isfinite(value) else None
            except OverflowError:
                pass
    return totals, coverage


def markdown(report):
    account = report['account']
    lines = ['# 内容分析报告', '', f'平台：{account["platform"]} · 账号：{account["name"]} ({account["accountId"]})',
             f'导出时间：{now()}', '', report['methodology'], '', '## 数据质量', '']
    lines.extend('- ' + warning for warning in report['quality']['warnings'])
    for content in report['contents']:
        lines += ['', '## ' + content['title'].replace('\n', ' '), '', f'作品 ID：{content["id"]} · 观察时间：{content["snapshotAt"]} · 口径：{content["period"]}', '',
                  '指标：' + '；'.join(f'{k}={v if v is not None else "缺失"}' for k, v in content['metrics'].items())]
        lines += ['高级指标：' + '；'.join(f'{k}={v if v is not None else "缺失"}' for k, v in (content.get('advancedMetrics') or {}).items())]
        for finding in content['diagnostics']:
            lines += ['', f'### {finding["dimension"]}', finding['observation'], '', '> ' + finding['evidence'].replace('\n', '\n> '), '', finding['action'], '', finding['limitation']]
        lines += ['', '### 创作起点', '', content['draft']['audienceQuestion'], '']
        lines.extend('- ' + point for point in content['draft']['outline'])
        if content.get('aiReview'):
            lines += ['', '### AI 深度解释', '', content['aiReview']['notice'], '']
            for finding in content['aiReview']['findings']:
                lines += [f'证据：{finding["evidenceId"]}', '> ' + finding['quote'].replace('\n', '\n> '),
                          finding['interpretation'], finding['action'], '']
    profile = report.get('platformProfile')
    if profile:
        lines += ['', '## 平台编辑视角', '', profile['label'], *['- ' + v for v in profile['focus']], *profile['limitations']]
    professional = report.get('professional')
    if professional:
        quality = professional['quality']
        lines += ['', '## 可诊断问题与数据依据', '', f'样本 {quality["total"]} 篇，可比 {quality["comparable"]} 篇；观察范围：{quality["observedFrom"] or "缺失"} 至 {quality["observedTo"] or "缺失"}', '']
        for capability in professional['capabilities']:
            lines += [f'- {capability["question"]} [{capability["status"]}] {capability["available"]}/{capability["total"]} 篇；需要：' + '、'.join(capability['required']) + '；' + capability['limitation']]
        for item in quality['excluded']:
            lines += [f'- 排除作品 {item["id"]}：' + '、'.join(item['reasons'])]
        lines += ['', '### 指标口径', '']
        lines.extend(f'- {item["label"]}（{item["unit"]}）：{item["formula"]}；{item["limitation"]}' for item in professional['metricDefinitions'])
        lines += ['', '## 待验证题材', '']
        for topic in professional['topics']:
            lines += [f'### {topic["label"]} [{topic["status"]}]', '', topic['observation'], '引用作品：' + '、'.join(topic['evidenceIds']),
                      '同组其他题材：' + ('、'.join(topic['counterexampleIds']) or '缺少比较作品'), topic['comparison'],
                      f'{topic["metricLabel"]}：{topic["value"] if topic["value"] is not None else "不可计算"}；比较值：{topic["baselineValue"] if topic["baselineValue"] is not None else "不可计算"}',
                      topic['hypothesis'], topic['action'], f'建议复查：{topic["reviewAt"] or "待设置"}', topic['stopRule'], *['- ' + value for value in topic['limitations']], '']
    insight = report.get('accountInsights')
    if insight:
        lines += ['', '## 跨作品 AI 解读', '', insight['notice']]
        for fact in insight['facts']:
            lines += ['', f"[{fact['id']}] {fact['text']}"]
        for item in insight['insights']:
            lines += ['', '引用：' + '、'.join(item['factIds']), item['observation'], item['action']]
    lines += ['', '## 行动与实验', '']
    for experiment in report['experiments']:
        lines += [f'- {experiment["title"]} [{experiment["status"]}]：{experiment["hypothesis"]}；改动：{experiment["action"]}；主指标：{experiment["metric"]}',
                  f'  结论：{experiment["conclusion"] or "待回收"}']
        if experiment.get('evidence'):
            lines += ['  冻结题材证据：' + json.dumps(experiment['evidence'], ensure_ascii=False, sort_keys=True)]
    return '\n'.join(lines) + '\n'

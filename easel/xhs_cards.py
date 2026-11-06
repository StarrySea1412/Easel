"""Three distinct XHS images, with file checks separate from visual review."""
from __future__ import annotations
import hashlib
import json
from PIL import Image
from .artifacts import scope, file_path, inspect_file, ArtifactStore
from .image_jobs import ImageJobs

ROLES = ('cover', 'content', 'ending')
CHECKS = ('readableText', 'consistentSubject', 'consistentStyle', 'distinctContent', 'truthfulClaims', 'safeMargins')
XHS_TOOL = {'type': 'function', 'name': 'easel_xhs_cards',
    'description': '制作小红书三图卡组。submit一次登记封面/卖点/场景收尾3张独立3:4图片；style统一主体与视觉。固定requestId，不改标识重试。status只读现有状态。三张保存不等于质量通过；逐张查看实际图片后review，逐项确认可读、主体/风格一致、内容不同、事实准确、边距安全，并提交当前sha256和逐图审图说明。review不生成或发布。',
    'inputSchema': {'type': 'object', 'additionalProperties': False, 'required': ['requestId', 'action'], 'properties': {
        'action': {'type': 'string', 'enum': ['submit', 'status', 'review']},
        'requestId': {'type': 'string', 'pattern': '^[A-Za-z0-9_.-]{1,100}$'},
        'style': {'type': 'string', 'minLength': 1, 'maxLength': 500},
        'referenceId': {'type': 'string', 'pattern': '^[a-f0-9]{32}$'},
        'prompts': {'type': 'array', 'minItems': 3, 'maxItems': 3, 'items': {'type': 'string', 'minLength': 1, 'maxLength': 1200}},
        'reviews': {'type': 'array', 'minItems': 3, 'maxItems': 3, 'items': {'type': 'object',
            'additionalProperties': False, 'required': ['sha256', 'evidence', *CHECKS], 'properties': {
                'sha256': {'type': 'string', 'pattern': '^[a-f0-9]{64}$'},
                'evidence': {'type': 'string', 'minLength': 10, 'maxLength': 600},
                **{k: {'type': 'boolean'} for k in CHECKS}}}}
    }}}


class XhsCards:
    def __init__(self, outputs):
        self.jobs = ImageJobs(outputs)

    @staticmethod
    def ident(session, turn, request):
        scope(session); scope(turn)
        if not isinstance(request, str) or len(scope(request)) > 100:
            raise ValueError('无效卡组请求标识')
        return hashlib.sha256(json.dumps([session, turn, request]).encode()).hexdigest()[:32]

    def execute(self, args, config, *, session, turn):
        request, action = args.get('requestId'), args.get('action')
        ident = self.ident(session, turn, request)
        if action == 'submit':
            style, prompts = args.get('style'), args.get('prompts')
            if not isinstance(style, str) or not 1 <= len(style.strip()) <= 500:
                raise ValueError('请提供统一主体、配色、光线和排版风格')
            if not isinstance(prompts, list) or len(prompts) != 3 or any(not isinstance(p, str) or not 1 <= len(p.strip()) <= 1200 for p in prompts):
                raise ValueError('必须分别提供三张图片的分镜提示词')
            if len({p.strip() for p in prompts}) != 3:
                raise ValueError('三张分镜内容不能相同')
            reference = args.get('referenceId')
            if reference is not None:
                from web.image_inputs import reference_path
                reference_path(self.jobs.outputs / '_image_references', reference)
            entries = []
            for i, (role, prompt) in enumerate(zip(ROLES, prompts)):
                text = f'小红书三图卡组，第{i+1}/3张，职责{role}。统一设定：{style.strip()}\n本张内容：{prompt.strip()}\n竖版3:4。画面主体一致但构图各异，清晰少字，文字置于安全边距内。不编造商品参数、价格、认证或效果。'
                payload = {'prompt': text, 'size': '768x1024'}
                if reference is not None:
                    payload.update(mode='img2img', referenceId=reference)
                entries.append((payload, request + f'.card{i+1}',
                    {'cardSetId': ident, 'cardIndex': i+1, 'cardRole': role}))
            self.jobs.submit_batch(entries, config, session=session, turn=turn)
        elif action not in ('status', 'review'):
            raise ValueError('无效卡组操作')
        result = self.get(session, turn, ident)
        if action == 'review':
            reviews = args.get('reviews')
            if result['ready'] != 3 or not isinstance(reviews, list) or len(reviews) != 3:
                raise ValueError('三张有效且不同的图片保存后才能审图')
            for card, review in zip(result['cards'], reviews):
                if not isinstance(review, dict) or review.get('sha256') != card.get('sha256') or any(review.get(k) is not True for k in CHECKS):
                    raise ValueError('审图未通过或文件已变化；保留原图，不自动重生')
                evidence = review.get('evidence')
                if not isinstance(evidence, str) or not 10 <= len(evidence.strip()) <= 600:
                    raise ValueError('每张图片需记录实际看到的内容与审图依据')
            with self.jobs.db() as db:
                db.execute('CREATE TABLE IF NOT EXISTS xhs_reviews(id TEXT PRIMARY KEY, data TEXT)')
                db.execute('INSERT OR REPLACE INTO xhs_reviews VALUES(?,?)', (ident, json.dumps(reviews, ensure_ascii=False)))
            result = self.get(session, turn, ident)
        return result

    def get(self, session, turn, ident):
        scope(session); scope(turn); scope(ident)
        with self.jobs.db() as db:
            rows = db.execute('SELECT * FROM jobs WHERE scope=? ORDER BY created', (session+':'+turn,)).fetchall()
            rows = [r for r in rows if json.loads(r['data']).get('cardSetId') == ident]
            rows = [r for r in rows if not json.loads(r['data']).get('retryJobId')]
            table = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='xhs_reviews'").fetchone()
            review = db.execute('SELECT data FROM xhs_reviews WHERE id=?', (ident,)).fetchone() if table else None
        if not rows:
            raise FileNotFoundError('卡组不存在')
        deliveries = ArtifactStore(self.jobs.outputs).snapshot(session)['artifacts']
        cards, seen = [], set()
        for row in sorted(rows, key=lambda r: json.loads(r['data'])['cardIndex']):
            job = self.jobs.public(row)
            card = {k: job[k] for k in ('jobId', 'cardIndex', 'cardRole', 'phase')}
            card.update(ready=False, error=job.get('error'))
            try:
                paths = job.get('paths', [])
                if job['phase'] != 'done' or job.get('error') or len(paths) != 1:
                    raise ValueError('图片尚未完整保存并交付')
                relative = paths[0]
                path, relative = file_path(self.jobs.outputs, relative)
                info = inspect_file(self.jobs.outputs, relative)
                if info['status'] != 'ready' or not info['mimeType'].startswith('image/') or job.get('imageHashes', {}).get(relative) != info['contentSha256']:
                    raise ValueError('图片文件缺失、不可读或已变化')
                if not any(a['id'] in job.get('artifactIds', []) and a['turnId'] == turn and a['path'] == relative for a in deliveries):
                    raise ValueError('图片尚未交付当前会话')
                with Image.open(path) as image:
                    width, height = image.size
                    if width * height > 16_000_000 or width < 720 or height < 960 or abs(width / height - .75) > .025:
                        raise ValueError('图片需为至少720×960的3:4竖版')
                    image.load()
                    pixels = hashlib.sha256(str(image.size).encode()+image.convert('RGB').tobytes()).hexdigest()
                if pixels in seen:
                    raise ValueError('图片与前图相同，不能重复凑数')
                seen.add(pixels)
                card.update(ready=True, sha256=info['contentSha256'], path=relative, width=width, height=height, error=None)
            except (ValueError, OSError, KeyError, Image.DecompressionBombError) as exc:
                card['error'] = str(exc) if isinstance(exc, ValueError) else '图片不可读取'
            cards.append(card)
        ready = sum(c['ready'] for c in cards)
        reviews = json.loads(review['data']) if review else []
        approved = len(cards) == ready == 3 and len(reviews) == 3 and all(r.get('sha256') == c.get('sha256') and all(r.get(k) is True for k in CHECKS) for r, c in zip(reviews, cards))
        return {'cardSetId': ident, 'sessionId': session, 'turnId': turn, 'expected': 3, 'ready': ready,
            'complete': approved, 'qualityState': 'assistant_reviewed' if approved else 'pending', 'cards': cards,
            'label': f'小红书卡组 · 已保存 {ready}/3 · '+('助手审图通过' if approved else '待质量验收')}

    def for_turn(self, session, turn):
        scope(session); scope(turn)
        if not self.jobs.path.is_file():
            return []
        with self.jobs.db() as db:
            rows = db.execute('SELECT data FROM jobs WHERE scope=?', (session+':'+turn,)).fetchall()
        ids = {json.loads(r['data']).get('cardSetId') for r in rows} - {None}
        return [self.get(session, turn, ident) for ident in sorted(ids)]

    def summaries(self, session):
        scope(session)
        with self.jobs.db() as db:
            rows = db.execute('SELECT data FROM jobs WHERE scope>=? AND scope<? ORDER BY created DESC', (session+':', session+';')).fetchall()
        groups = {}
        for row in rows:
            job = json.loads(row['data'])
            if job.get('cardSetId') and job['cardSetId'] not in groups and len(groups) < 10:
                groups[job['cardSetId']] = self.get(session, job['turnId'], job['cardSetId'])
        return groups

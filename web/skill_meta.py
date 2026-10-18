"""技能元数据：标签、分类与覆盖层编辑（不改第三方 SKILL.md 本体）。

存储 `<DATA_DIR>/skill-meta.json`：
  {"version":1,"skills":{<目录名>:{"displayName?","description?","tags":[],"categoryId?}},"categories":[{"id":"user-…","label":…}]}
预设分类写死在代码里；自动标签分类内置离线规则，"ai" 模式经注入的 runner 调用已配置模型。
"""
from __future__ import annotations

import json
import re
import secrets
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException

MAX_TAGS = 8
MAX_TAG_CHARS = 24
MAX_LABEL_CHARS = 20
MAX_DISPLAY_CHARS = 60
MAX_DESCRIPTION_CHARS = 300
MAX_CUSTOM_CATEGORIES = 24
MAX_CLASSIFY_ITEMS = 200

PRESET_CATEGORIES = [
    {'id': 'preset-content', 'label': '内容创作', 'preset': True},
    {'id': 'preset-research', 'label': '研究分析', 'preset': True},
    {'id': 'preset-visual', 'label': '视觉设计', 'preset': True},
    {'id': 'preset-video', 'label': '视频制作', 'preset': True},
    {'id': 'preset-audio', 'label': '音频语音', 'preset': True},
    {'id': 'preset-publish', 'label': '发布运营', 'preset': True},
    {'id': 'preset-office', 'label': '办公效率', 'preset': True},
    {'id': 'preset-tools', 'label': '工具与自动化', 'preset': True},
]

# 离线自动标签规则：命中任一关键字即加该标签（名称与描述都参与匹配）。
_TAG_RULES: list[tuple[str, tuple[str, ...]]] = [
    ('小红书', ('xhs', '小红书', 'xiaohongshu')),
    ('抖音', ('douyin', '抖音')),
    ('微博', ('weibo', '微博')),
    ('知乎', ('zhihu', '知乎')),
    ('B站', ('bilibili', 'b站')),
    ('公众号', ('wechat', 'weixin', '公众号', 'gzh')),
    ('视频', ('video', '视频', 'short-video', '口播')),
    ('图像', ('image', '图像', '修图', 'photo', 'pic')),
    ('设计', ('design', '卡片', 'card', '海报', 'poster', 'cover', '封面')),
    ('音频', ('audio', '音频', '配音', 'voice', 'tts', '音乐', 'music', 'denoise')),
    ('文案', ('copy', '文案', '写作', 'writer', 'polish', 'writer')),
    ('分析', ('analysis', '分析', '诊断', 'report', '数据', 'data')),
    ('研究', ('research', '研究', 'paper', '热点', 'trending', 'news')),
    ('发布', ('publish', '发布', 'publisher', 'schedule')),
    ('自动化', ('auto', '自动化', 'batch', 'workflow', 'skill-')),
    ('办公', ('doc', '文档', 'office', 'excel', 'ppt', 'pdf', 'convert')),
    ('选题', ('选题', 'idea', 'topic', 'calendar', '排期')),
]

# 标签 → 预设分类的粗映射（用于自动分类的建议分类，用户可在编辑里改掉）。
_TAG_CATEGORY: dict[str, str] = {
    '视频': 'preset-video', '图像': 'preset-visual', '设计': 'preset-visual',
    '音频': 'preset-audio', '发布': 'preset-publish', '公众号': 'preset-publish',
    '办公': 'preset-office', '自动化': 'preset-tools',
    '分析': 'preset-research', '研究': 'preset-research', '选题': 'preset-research',
    '文案': 'preset-content', '小红书': 'preset-content', '抖音': 'preset-content',
    '微博': 'preset-content', '知乎': 'preset-content', 'B站': 'preset-content',
}


def _clean(value, limit: int) -> str:
    if not isinstance(value, str):
        raise HTTPException(400, '字段必须是文本')
    return ' '.join(value.split())[:limit]


def _tags(value) -> list[str]:
    if not isinstance(value, list):
        raise HTTPException(400, 'tags 必须是数组')
    result: list[str] = []
    for item in value:
        tag = _clean(item, MAX_TAG_CHARS)
        if tag and tag not in result:
            result.append(tag)
    if len(result) > MAX_TAGS:
        raise HTTPException(400, f'最多 {MAX_TAGS} 个标签')
    return result


def classify_offline(name: str, description: str) -> dict:
    haystack = f'{name} {description}'.lower()
    tags = [tag for tag, keys in _TAG_RULES if any(key in haystack for key in keys)]
    priority = ['preset-publish', 'preset-video', 'preset-audio', 'preset-visual', 'preset-office', 'preset-research', 'preset-tools', 'preset-content']
    mapped = [_TAG_CATEGORY[tag] for tag in tags if tag in _TAG_CATEGORY]
    category = min(mapped, key=priority.index) if mapped else None
    return {'tags': tags[:MAX_TAGS], 'categoryId': category}


class SkillMetaStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()

    # ---- 存储 ----
    def _load(self) -> dict:
        if not self.path.is_file():
            return {'version': 1, 'skills': {}, 'categories': []}
        try:
            value = json.loads(self.path.read_text(encoding='utf-8'))
        except (ValueError, UnicodeDecodeError):
            raise HTTPException(500, '技能元数据无法读取') from None
        if not isinstance(value, dict):
            raise HTTPException(500, '技能元数据格式无效')
        skills = value.get('skills') if isinstance(value.get('skills'), dict) else {}
        categories = value.get('categories') if isinstance(value.get('categories'), list) else []
        return {'version': 1, 'skills': skills, 'categories': categories}

    def _save(self, value: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix('.tmp')
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding='utf-8')
        temp.replace(self.path)

    def categories(self, value: dict | None = None) -> list[dict]:
        state = value if value is not None else self._load()
        return PRESET_CATEGORIES + [c for c in state['categories'] if isinstance(c, dict) and c.get('id') and c.get('label')]

    def _require_category(self, category_id, value: dict) -> str | None:
        if category_id in (None, ''):
            return None
        if not isinstance(category_id, str) or category_id not in {c['id'] for c in self.categories(value)}:
            raise HTTPException(400, '分类不存在，请先创建或选择已有分类')
        return category_id

    # ---- 对外 ----
    def read(self) -> dict:
        with self._lock:
            value = self._load()
        return {'skills': value['skills'], 'categories': self.categories(value)}

    def update_skill(self, name: str, payload: dict) -> dict:
        if not isinstance(payload, dict):
            raise HTTPException(400, '请求体必须是对象')
        with self._lock:
            value = self._load()
            current = value['skills'].get(name) if isinstance(value['skills'].get(name), dict) else {}
            entry = dict(current)
            if 'tags' in payload:
                entry['tags'] = _tags(payload.get('tags'))
            if 'categoryId' in payload:
                entry['categoryId'] = self._require_category(payload.get('categoryId'), value)
            if 'displayName' in payload:
                display = _clean(payload.get('displayName'), MAX_DISPLAY_CHARS)
                if display:
                    entry['displayName'] = display
                else:
                    entry.pop('displayName', None)
            if 'description' in payload:
                description = _clean(payload.get('description'), MAX_DESCRIPTION_CHARS)
                if description:
                    entry['description'] = description
                else:
                    entry.pop('description', None)
            value['skills'][name] = entry
            self._save(value)
            return entry

    def create_category(self, label) -> dict:
        text = _clean(label, MAX_LABEL_CHARS)
        if not text:
            raise HTTPException(400, '分类名称不能为空')
        with self._lock:
            value = self._load()
            if text in {c['label'] for c in self.categories(value)}:
                raise HTTPException(409, '同名分类已存在')
            if len(value['categories']) >= MAX_CUSTOM_CATEGORIES:
                raise HTTPException(400, f'自定义分类已达上限（{MAX_CUSTOM_CATEGORIES} 个）')
            category = {'id': f'user-{secrets.token_urlsafe(6)}', 'label': text, 'preset': False}
            value['categories'].append(category)
            self._save(value)
            return category

    def classify(self, mode: str, items: list[dict], runner=None) -> dict:
        if mode not in ('rules', 'ai'):
            raise HTTPException(400, 'mode 必须是 rules 或 ai')
        if not isinstance(items, list) or not items or len(items) > MAX_CLASSIFY_ITEMS:
            raise HTTPException(400, f'items 必须是 1–{MAX_CLASSIFY_ITEMS} 项数组')
        catalog = []
        for item in items:
            if not isinstance(item, dict):
                raise HTTPException(400, 'item 必须是对象')
            name = _clean(item.get('name'), 120)
            if not name:
                raise HTTPException(400, 'item 缺少 name')
            catalog.append({'name': name, 'description': _clean(item.get('description'), MAX_DESCRIPTION_CHARS)})
        if mode == 'rules':
            return {'mode': 'rules', 'suggestions': {item['name']: classify_offline(item['name'], item['description']) for item in catalog}}
        if runner is None:
            raise HTTPException(409, '未接入可用模型，无法进行 AI 识别；可先用离线规则分类')
        preset_labels = ', '.join(c['label'] for c in PRESET_CATEGORIES)
        listing = '\n'.join(f"- {item['name']}: {item['description'][:120]}" for item in catalog)
        prompt = (
            '你是技能归类助手。请把下面的技能归入预设分类，并为每个技能给出 1–3 个中文短标签。\n'
            f'预设分类（category 只能从中选一个或留空）：{preset_labels}\n'
            '只输出 JSON，形如 {"技能名": {"tags": ["标签"], "category": "分类名"}}。\n技能列表：\n' + listing
        )
        try:
            raw = runner(prompt)
        except Exception as error:  # runner 自身的失败要如实透出，不伪造结果
            raise HTTPException(409, f'AI 识别失败：{error}') from None
        match = re.search(r'\{.*\}', raw or '', re.S)
        if not match:
            raise HTTPException(502, 'AI 识别输出无法解析，请重试或改用离线规则')
        try:
            parsed = json.loads(match.group(0))
        except ValueError:
            raise HTTPException(502, 'AI 识别输出无法解析，请重试或改用离线规则') from None
        label_to_id = {c['label']: c['id'] for c in PRESET_CATEGORIES}
        suggestions = {}
        for item in catalog:
            got = parsed.get(item['name']) if isinstance(parsed, dict) else None
            if not isinstance(got, dict):
                continue
            tags = [tag for tag in [_clean(t, MAX_TAG_CHARS) for t in (got.get('tags') or []) if isinstance(t, str)] if tag][:MAX_TAGS]
            category = label_to_id.get(_clean(got.get('category'), MAX_LABEL_CHARS)) if isinstance(got.get('category'), str) else None
            suggestions[item['name']] = {'tags': tags, 'categoryId': category}
        if not suggestions:
            raise HTTPException(502, 'AI 识别没有返回可用归类，请重试或改用离线规则')
        return {'mode': 'ai', 'suggestions': suggestions}


def create_router(store: SkillMetaStore, list_skills, runner=None) -> APIRouter:
    router = APIRouter()

    @router.get('/api/skills/meta')
    async def read_meta():
        return store.read()

    @router.put('/api/skill/{name}/meta')
    async def update_meta(name: str, payload: dict):
        if name not in {item['name'] for item in list_skills()}:
            raise HTTPException(404, f'SKILL “{name}” 不存在')
        return store.update_skill(name, payload)

    @router.post('/api/skill-categories')
    async def create_category(payload: dict):
        if not isinstance(payload, dict):
            raise HTTPException(400, '请求体必须是对象')
        return store.create_category(payload.get('label'))

    @router.post('/api/skills/classify')
    async def classify(payload: dict):
        if not isinstance(payload, dict):
            raise HTTPException(400, '请求体必须是对象')
        known = {item['name'] for item in list_skills()}
        items = payload.get('items')
        if items is None:
            items = [{'name': item['name'], 'description': item.get('description', '')} for item in list_skills()]
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict) or item.get('name') not in known:
                raise HTTPException(404, f"SKILL “{(item or {}).get('name')}” 不存在")
        return store.classify(payload.get('mode'), items, runner)
    return router

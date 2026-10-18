"""技能元数据：覆盖层编辑、分类校验、离线/`AI` 自动标签；全部落在临时目录。"""
import json
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
import skill_meta


@pytest.fixture()
def store(tmp_path):
    return skill_meta.SkillMetaStore(tmp_path / 'skill-meta.json')


def test_skill_metadata_editing_persists_and_clears_overrides(store):
    saved = store.update_skill('card-quote', {'tags': ['设计', '卡片'], 'categoryId': 'preset-visual', 'displayName': '金句卡片', 'description': '把金句排成卡片'})
    assert saved['tags'] == ['设计', '卡片']
    assert store.read()['skills']['card-quote']['displayName'] == '金句卡片'
    cleared = store.update_skill('card-quote', {'displayName': '  ', 'categoryId': ''})
    assert 'displayName' not in cleared and cleared['categoryId'] is None
    with pytest.raises(HTTPException) as error:
        store.update_skill('card-quote', {'categoryId': 'preset-nope'})
    assert error.value.status_code == 400
    with pytest.raises(HTTPException) as error:
        store.update_skill('card-quote', {'tags': [f't{i}' for i in range(9)]})
    assert error.value.status_code == 400


def test_custom_categories_join_the_presets_and_reject_duplicates(store):
    presets = [c['id'] for c in store.read()['categories']]
    assert 'preset-content' in presets and 'preset-tools' in presets
    created = store.create_category('  我的专栏  ')
    assert created['label'] == '我的专栏' and created['preset'] is False
    assert created['id'] in [c['id'] for c in store.read()['categories']]
    with pytest.raises(HTTPException) as error:
        store.create_category('我的专栏')
    assert error.value.status_code == 409
    assert store.update_skill('skill-zhihu-publisher', {'categoryId': created['id']})['categoryId'] == created['id']


def test_offline_rules_classify_known_skills_deterministically(store):
    items = [
        {'name': 'skill-zhihu-publisher', 'description': '把文章发布到知乎'},
        {'name': 'card-quote', 'description': '把金句排成卡片'},
        {'name': 'video-reframe', 'description': '视频改幅'},
        {'name': 'totally-unknown', 'description': '没有关键字'},
    ]
    result = store.classify('rules', items)
    assert result['mode'] == 'rules'
    assert '知乎' in result['suggestions']['skill-zhihu-publisher']['tags']
    assert '发布' in result['suggestions']['skill-zhihu-publisher']['tags']
    assert result['suggestions']['skill-zhihu-publisher']['categoryId'] == 'preset-publish'
    assert '设计' in result['suggestions']['card-quote']['tags']
    assert '视频' in result['suggestions']['video-reframe']['tags']
    assert result['suggestions']['totally-unknown'] == {'tags': [], 'categoryId': None}


def test_ai_classification_uses_the_runner_and_fails_honestly(store):
    items = [{'name': 'card-quote', 'description': '金句卡片'}]
    def runner(prompt):
        assert 'card-quote' in prompt and '内容创作' in prompt
        return '结果：{"card-quote": {"tags": ["设计", "卡片"], "category": "视觉设计"}}'
    result = store.classify('ai', items, runner)
    assert result['mode'] == 'ai'
    assert result['suggestions']['card-quote'] == {'tags': ['设计', '卡片'], 'categoryId': 'preset-visual'}
    def broken(prompt):
        raise RuntimeError('模型不可用')
    with pytest.raises(HTTPException) as error:
        store.classify('ai', items, broken)
    assert error.value.status_code == 409 and '模型不可用' in error.value.detail
    with pytest.raises(HTTPException) as error:
        store.classify('ai', items, lambda prompt: '不是 JSON')
    assert error.value.status_code == 502
    with pytest.raises(HTTPException) as error:
        store.classify('ai', items, None)
    assert error.value.status_code == 409


def test_skills_api_surfaces_saved_metadata_and_routes_are_mounted(store, monkeypatch):
    store.update_skill('card-quote', {'tags': ['设计'], 'categoryId': 'preset-visual', 'displayName': '卡片达人'})
    monkeypatch.setattr(web, '_SKILL_META_STORE', store)
    skills = {item['name']: item for item in web.get_skills()}
    assert skills['card-quote']['tags'] == ['设计']
    assert skills['card-quote']['categoryId'] == 'preset-visual'
    assert skills['card-quote']['displayName'] == '卡片达人'
    assert 'card-design' in skills and 'tags' not in skills['card-design']
    monkeypatch.setattr(web, '_SKILL_META_STORE', None)
    paths = set(web.app.openapi()['paths'])
    assert {'/api/skills/meta', '/api/skill/{name}/meta', '/api/skill-categories', '/api/skills/classify'} <= paths

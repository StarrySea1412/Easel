import asyncio
from pathlib import Path
import sys

import pytest
from fastapi import HTTPException

from easel.skill_prompts import SkillPrompts

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web


@pytest.fixture
def skill(tmp_path, monkeypatch):
    path = tmp_path / 'skills/openclaw/skill-example/SKILL.md'
    path.parent.mkdir(parents=True)
    path.write_text('---\ndescription: Test skill\n---\n# Original\n\nPrepare a report.\n', encoding='utf-8')
    monkeypatch.setattr(web, 'SKILLS_DIR', tmp_path / 'skills')
    monkeypatch.setattr(web, 'DATA_DIR', tmp_path / 'data')
    monkeypatch.setattr(web, '_read_env', lambda: {})
    return path, tmp_path / 'data'


def test_save_persists_and_never_mutates_installed_source(skill):
    path, data = skill
    source = path.read_bytes()
    store = SkillPrompts(data)
    original = store.read('skill-example', path)
    assert not store.path.exists()
    saved = store.save('skill-example', path, '# My report\nKeep sources.', original['promptRevision'])
    assert saved['promptCustomized'] is True
    assert SkillPrompts(data).read('skill-example', path) == saved
    assert path.read_bytes() == source
    assert not store.read('other-skill', path)['promptCustomized']


def test_stale_edits_and_changed_package_cannot_overwrite_saved_body(skill):
    path, data = skill
    store = SkillPrompts(data)
    original = store.read('skill-example', path)
    saved = store.save('skill-example', path, 'First saved edit', original['promptRevision'])
    with pytest.raises(ValueError, match='其他页面修改'):
        store.save('skill-example', path, 'Stale edit', original['promptRevision'])
    path.write_text('Updated package', encoding='utf-8')
    with pytest.raises(ValueError, match='其他页面修改'):
        store.save('skill-example', path, 'New edit', saved['promptRevision'])
    assert store.read('skill-example', path)['body'] == 'First saved edit'


def test_detail_save_and_next_selected_skill_call_use_same_body(skill, monkeypatch):
    path, _ = skill
    initial = asyncio.run(web.api_skill_detail('skill-example'))
    assert initial['body'].startswith('# Original')
    saved = asyncio.run(web.api_skill_prompt_save('skill-example', web.SkillPromptRequest(
        body='# Custom\nWrite a concise report with sources.', promptRevision=initial['promptRevision'])))
    assert saved['body'].startswith('# Custom')
    assert asyncio.run(web.api_skill_detail('skill-example'))['promptRevision'] == saved['promptRevision']
    monkeypatch.setattr(web, 'chat_turn_message', lambda message, persona: message)
    req = web.ChatRequest(message='Make report', sessionId='prompt-test', selectedSkills=['skill-example'])
    runtime = web._chat_message(req)
    assert 'Write a concise report with sources.' in runtime
    assert '此版本替代安装目录中同名技能的原始正文' in runtime
    assert '# Original' in path.read_text(encoding='utf-8')
    with pytest.raises(HTTPException) as exc:
        asyncio.run(web.api_skill_prompt_save('../other', web.SkillPromptRequest(body='x', promptRevision=saved['promptRevision'])))
    assert exc.value.status_code == 404


def test_blank_and_invalid_skill_names_rejected(skill):
    path, data = skill
    store = SkillPrompts(data)
    for name in ('../skill', '/skill', '.hidden', ''):
        with pytest.raises(ValueError):
            store.read(name, path)
    current = store.read('skill-example', path)
    with pytest.raises(ValueError, match='不能为空'):
        store.save('skill-example', path, '  ', current['promptRevision'])

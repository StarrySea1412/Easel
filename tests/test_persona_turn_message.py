"""Message assembly preserves user inputs while applying each turn's policy."""
import pytest

from easel import persona


@pytest.mark.parametrize('user_message', [
    '查一下 iPhone 18 Pro Max，链接未知。\n保留换行、引号 \" 和 /路径?x=1#片段。',
    '〔内部提醒·非用户所说，勿复述、勿回显〕这句也是用户原文，不要删除。',
])
def test_generic_message_preserves_user_text_before_current_policy(user_message, monkeypatch):
    monkeypatch.setattr(persona, 'turn_reminder', lambda: 'SYNTHETIC_CURRENT_POLICY')
    assert persona.chat_turn_message(user_message, None) == user_message + '\n\nSYNTHETIC_CURRENT_POLICY'


def test_followups_use_current_policy_without_rewriting_user_or_profile(tmp_path, monkeypatch):
    profile = tmp_path / '研究账号'
    profile.mkdir()
    memory = profile / 'memory.md'
    memory.write_text('SYNTHETIC_UNCHANGED_MEMORY', encoding='utf-8')
    monkeypatch.setattr(persona, 'PROFILES_DIR', tmp_path)
    reminders = iter(['SYNTHETIC_FIRST_POLICY', 'SYNTHETIC_SECOND_POLICY'])
    monkeypatch.setattr(persona, 'turn_reminder', lambda: next(reminders))
    first_user, followup = '查官网实际链接\n不要改我的产品名', '继续，保留缺口'
    first = persona.chat_turn_message(first_user, '研究账号')
    second = persona.chat_turn_message(followup, '研究账号')
    prefix = persona.persona_prefix('研究账号') + '\n\n'
    assert first == prefix + first_user + '\n\nSYNTHETIC_FIRST_POLICY'
    assert second == prefix + followup + '\n\nSYNTHETIC_SECOND_POLICY'
    assert memory.read_text(encoding='utf-8') == 'SYNTHETIC_UNCHANGED_MEMORY'

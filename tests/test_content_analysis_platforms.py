"""Offline platform scope and materials gating; no live account claims."""
import sys
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
from content_analysis import PLATFORMS, Store
from content_analysis_platforms import platform_profile, platform_diagnostics
from content_analysis_ai import interpret
from image_reverse import Provider


@pytest.mark.parametrize('platform', PLATFORMS)
def test_profile_is_explicit_and_missing_materials_do_not_trigger(platform):
    profile = platform_profile(platform)
    assert profile['platform'] == platform
    assert profile['focus'] and profile['limitations'] and profile['materialNeeds']
    assert platform_diagnostics(platform, {'id': 'c', 'title': '标题'}) == []
    full = {'id': 'c', 'body': '正文需要来源', 'transcript': '这里是真实口播', 'comments': ['这个怎么操作？'], 'coverText': '封面承诺'}
    findings = platform_diagnostics(platform, full)
    assert len(findings) == 2
    assert all(profile['label'] in f['dimension'] and f['evidence'] for f in findings)
    assert platform_diagnostics(platform, dict(full, body='。！？', transcript='。！？', comments=[], coverText='！？')) == []


def test_platforms_have_distinct_lenses_and_profiles_are_not_mutable_global():
    assert len({tuple(platform_profile(p)['focus']) for p in PLATFORMS}) == 7
    profile = platform_profile('zhihu')
    profile['focus'].clear()
    assert platform_profile('zhihu')['focus']


def test_interpret_sends_platform_context_without_other_account_or_credentials(tmp_path, monkeypatch):
    store = Store(tmp_path)
    report = store.ingest({'platform': 'zhihu', 'accountId': 'a', 'contents': [{'id': 'c', 'body': '真实论证材料'}]})
    seen = {}
    def fake(provider, system, prompt):
        seen.update(system=system, prompt=prompt)
        return {'findings': [{'evidenceId': 'c:body', 'quote': '真实论证材料', 'interpretation': '论点需要说明适用条件', 'action': '补充可核验的信息来源'}]}
    monkeypatch.setattr('content_analysis_ai.request_json', fake)
    interpret(report['contents'][0], Provider('test', 'Test', 'model', 'openai', 'https://example.invalid/v1', 'secret-marker'), 'zhihu')
    assert '知乎' in seen['prompt'] and '论证来源' in seen['prompt']
    assert 'secret-marker' not in seen['prompt'] and 'platformProfile' in seen['system']

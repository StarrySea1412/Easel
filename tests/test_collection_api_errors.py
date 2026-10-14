"""Offline API failure receipts keep saved data and platform context accurate."""
import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'web')]
import app as web


def request(path):
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=web.app),
                                     base_url='http://127.0.0.1') as client:
            return await client.get(path)
    return asyncio.run(run())


@pytest.mark.parametrize('mode,expected', [('', '本地采集组件加载失败'),
                                          ('production', '服务端采集组件加载失败'),
                                          ('isolated-test', '服务端采集组件加载失败')])
def test_analytics_missing_sibling_returns_classified_detail_and_preserves_saved_data(tmp_path, monkeypatch, mode, expected):
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path)
    monkeypatch.setenv('EASEL_DEPLOYMENT_MODE', mode)
    previous = tmp_path / '_analytics' / 'saved.json'
    previous.parent.mkdir()
    previous.write_text('SYNTHETIC_LAST_GOOD_DATA', encoding='utf-8')
    observed = {}

    def failed_collector(command, **kwargs):
        observed.update(kwargs)
        return SimpleNamespace(stdout='', stderr="ModuleNotFoundError: No module named 'account_evidence'", returncode=1)

    monkeypatch.setattr(web.subprocess, 'run', failed_collector)
    response = request('/api/analytics/xiaohongshu')
    assert response.status_code == 500
    message = response.json()['detail']
    assert expected in message and '已保留原有数据' in message
    assert '可能未登录' not in message
    assert previous.read_text(encoding='utf-8') == 'SYNTHETIC_LAST_GOOD_DATA'
    assert observed['encoding'] == 'utf-8' and observed['errors'] == 'replace'
    assert observed['env']['EASEL_ANALYTICS_MANAGED'] == '1'
    if mode:
        assert '镜像' in message and '重启当前源码项目' not in message


def test_skill_catalog_route_is_local_and_independent_of_account_collector(tmp_path, monkeypatch):
    catalog = tmp_path / 'skills' / 'openclaw' / 'fixture-skill'
    catalog.mkdir(parents=True)
    (catalog / 'SKILL.md').write_text('---\ndescription: Offline fixture\n---\n# Fixture', encoding='utf-8')
    monkeypatch.setattr(web, 'SKILLS_DIR', tmp_path / 'skills')
    monkeypatch.setattr(web, '_read_env', lambda: {})
    monkeypatch.setattr(web.subprocess, 'run', lambda *args, **kwargs: pytest.fail('Skill catalog must not launch the account collector'))
    response = request('/api/skills')
    assert response.status_code == 200
    assert response.json() == [{'name': 'fixture-skill', 'description': 'Offline fixture',
                                'layer': '', 'needsApi': False, 'apiConfigured': True}]

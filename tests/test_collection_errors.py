"""Offline failures must not misreport logout or overwrite saved analytics."""
import subprocess
import sys
from pathlib import Path

import pytest

from easel.collection_errors import collection_failure


@pytest.mark.parametrize('stderr,code,phrase', [
    ("ModuleNotFoundError: No module named 'account_evidence'", 500, '本地采集组件加载失败'),
    ('ModuleNotFoundError: No module named "playwright"', 500, '缺少依赖'),
    ("Executable doesn't exist at /browser", 500, '浏览器未就绪'),
    ('ConnectionError: request timed out', 502, '连接失败或超时'),
    ('unexpected response', 502, '未返回有效数据'),
    ('ERROR: 小红书登录目录正被占用：C:/private/account/profile', 409, '登录目录正被占用'),
])
def test_failure_explains_observed_cause(stderr, code, phrase):
    status, message = collection_failure(stderr, deployment_mode='')
    assert status == code and phrase in message
    assert '已保留原有数据' in message
    assert '可能未登录' not in message
    assert 'C:/private' not in message


def test_deployed_component_failures_point_to_image_maintenance_not_local_restart():
    code, message = collection_failure(
        "ModuleNotFoundError: No module named 'account_evidence'",
        deployment_mode='production',
    )
    assert code == 500
    assert '部署镜像' in message and '重启当前源码项目' not in message
    code, message = collection_failure("Executable doesn't exist at /browser", deployment_mode='isolated-test')
    assert code == 500
    assert '服务端采集浏览器未就绪' in message and '设置中的环境检查' not in message


def test_local_component_failures_keep_local_repair_guidance():
    code, message = collection_failure(
        "ModuleNotFoundError: No module named 'requests'",
        deployment_mode='development',
    )
    assert code == 500
    assert '设置中的环境检查' in message


def test_current_deployment_environment_selects_server_guidance(monkeypatch):
    monkeypatch.setenv('EASEL_DEPLOYMENT_MODE', 'production')
    status, message = collection_failure('ModuleNotFoundError: No module named "playwright"')
    assert status == 500 and '服务端' in message and '镜像' in message
    assert '设置中的环境检查' not in message
    monkeypatch.delenv('EASEL_DEPLOYMENT_MODE')
    status, message = collection_failure('ModuleNotFoundError: No module named "playwright"')
    assert status == 500 and '设置中的环境检查' in message


def test_account_stats_loads_bundled_sibling_in_isolated_python():
    script = Path(__file__).resolve().parents[1] / 'skills/shared/scripts/account_stats.py'
    result = subprocess.run([sys.executable, '-I', '-X', 'utf8', str(script), 'selftest'],
                            capture_output=True, encoding='utf-8', timeout=30)
    assert result.returncode == 0, result.stderr

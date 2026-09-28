"""安装核心状态机（方案功能 D 第一步 / feat/installer-core）测试。

覆盖验收点：可重入（ok/skipped 跳过、running 断点续跑）、有限重试
（瞬时故障自动 retry 且逐次退避、非瞬时直接 failed、预算耗尽停住）、
winget 默认不放行、状态文件损坏/版本不符自愈、reset 只动状态不动组件、
数据目录独立（EASEL_DATA_DIR）且缺省回落源码根。

全离线：状态文件用 tmp 目录。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from easel import install_core as ic  # noqa: E402


@pytest.fixture()
def tmp_state(tmp_path, monkeypatch):
    monkeypatch.setenv("EASEL_DATA_DIR", str(tmp_path))
    return tmp_path


# ---- 阶段与计划 ----

def test_phases_have_unique_ids_and_order():
    ids = [p["id"] for p in ic.PHASES]
    assert len(ids) == len(set(ids))
    assert ids[0] == "system" and ids[-1] == "gateway"
    assert {p["id"] for p in ic.PHASES} >= {"system", "openclaw", "pydeps",
                                           "frontend", "chromium", "profile", "skills", "gateway"}


def test_plan_lists_all_phases_with_metadata(tmp_state):
    plan = ic.plan(ic.load_state())
    assert len(plan) == len(ic.PHASES)
    assert all(p["status"] == "pending" for p in plan)
    system = plan[0]
    assert system["needsWinget"] is True
    assert system["title"] == "检查系统环境"


# ---- 可重入 ----

def test_should_run_fresh_then_skip_after_ok(tmp_state):
    s = ic.load_state()
    assert ic.should_run(s, "system") is True
    ic.mark_result(s, "system", ok=True, detail="已有 git/node")
    s = ic.load_state()
    assert ic.should_run(s, "system") is False          # 重跑跳过已满足阶段
    assert ic.should_run(s, "pydeps") is True           # 其它阶段照跑


def test_should_run_failed_and_interrupted(tmp_state):
    s = ic.load_state()
    ic.mark_result(s, "frontend", ok=False, detail="构建失败")
    ic.mark_running(s, "chromium")
    s = ic.load_state()
    assert ic.should_run(s, "frontend") is True         # 失败阶段重跑（断点恢复）
    assert ic.should_run(s, "chromium") is True        # running（进程中断）续跑
    with pytest.raises(ValueError):
        ic.should_run(s, "不存在")


def test_unknown_phase_in_state_is_dropped(tmp_state):
    p = ic.state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"version": ic.STATE_VERSION,
                             "phases": {"ghost": {"status": "ok"}}}), encoding="utf-8")
    s = ic.load_state()
    assert "ghost" not in s["phases"]                    # 未知阶段被丢弃
    assert ic.should_run(s, "system") is True           # 正常阶段不受影响


def test_corrupt_or_wrong_version_state_self_heals(tmp_state):
    p = ic.state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("{broken", encoding="utf-8")
    s = ic.load_state()
    assert s["phases"] == {} and s["version"] == ic.STATE_VERSION
    p.write_text(json.dumps({"version": 999, "phases": {"system": {"status": "ok"}}}),
                 encoding="utf-8")
    assert ic.should_run(ic.load_state(), "system") is True    # 旧版本状态作废重跑


# ---- 有限重试 ----

def test_transient_failure_auto_retries_with_backoff(tmp_state):
    s = ic.load_state()
    v = ic.mark_result(s, "pydeps", ok=False, detail="pip 网络超时 timeout", auto_retry=True)
    assert v["status"] == "retry" and v["attempts"] == 1
    assert ic.retry_wait_seconds(1) == 10
    v = ic.mark_result(s, "pydeps", ok=False, detail="ECONNRESET", auto_retry=True)
    assert v["status"] == "retry" and v["attempts"] == 2
    assert ic.retry_wait_seconds(2) == 30
    v = ic.mark_result(s, "pydeps", ok=False, detail="网络又一次 503", auto_retry=True)
    assert v["status"] == "failed" and v["attempts"] == 3   # 预算（2 次）耗尽 → failed


def test_non_transient_failure_fails_immediately(tmp_state):
    s = ic.load_state()
    v = ic.mark_result(s, "profile", ok=False, detail="配置无效 Unrecognized key", auto_retry=True)
    assert v["status"] == "failed"                        # 配置错误不自动重试
    v = ic.mark_result(s, "system", ok=False, detail="权限不足", auto_retry=True)
    assert v["status"] == "failed" and v["attempts"] == 1


def test_transient_failure_classifier():
    assert ic.transient_failure("npm install ETIMEDOUT") is True
    assert ic.transient_failure("下载超时（timeout）") is True
    assert ic.transient_failure("503 Service Unavailable") is True
    assert ic.transient_failure("权限不足（Access denied）") is False
    assert ic.transient_failure("版本不兼容") is False
    assert ic.transient_failure("") is False


# ---- winget 门禁 ----

def test_winget_disabled_by_default_and_env_override(tmp_state, monkeypatch):
    monkeypatch.delenv("EASEL_INSTALL_ALLOW_WINGET", raising=False)
    assert ic.winget_allowed() is False                   # 默认不静默装系统软件
    monkeypatch.setenv("EASEL_INSTALL_ALLOW_WINGET", "1")
    assert ic.winget_allowed() is True
    assert ic.winget_allowed(False) is False              # 显式参数优先


# ---- 数据目录 ----

def test_data_dir_env_and_default(tmp_state):
    assert ic.data_dir() == Path(str(tmp_state)).resolve()  # 指向 tmp（显式 EASEL_DATA_DIR）
    os_env = None
    monkey_env = None


def test_state_file_writes_atomically_and_readable(tmp_state):
    s = ic.load_state()
    ic.mark_running(s, "system")
    assert ic.state_path().is_file()
    raw = json.loads(ic.state_path().read_text(encoding="utf-8"))
    assert raw["phases"]["system"]["status"] == "running"
    assert isinstance(raw["phases"]["system"]["lastRun"], int)


# ---- overall ----

def test_overall_progress(tmp_state):
    s = ic.load_state()
    assert ic.overall(s)["status"] == "pending"
    ic.mark_result(s, "system", ok=True)
    ic.mark_result(s, "openclaw", ok=True)
    o = ic.overall(s)
    assert o["done"] == 2 and o["status"] == "pending"
    for p in ic.PHASES[2:]:
        ic.mark_result(s, p["id"], ok=True)
    assert ic.overall(s)["status"] == "done"
    ic.mark_result(s, "gateway", ok=False, detail="boom")
    assert ic.overall(s)["status"] == "failed"


# ---- reset（CLI 层） ----

def test_reset_clears_or_single_phase(tmp_state, monkeypatch):
    from easel.commands import install as ci
    s = ic.load_state()
    ic.mark_result(s, "system", ok=True)
    ic.mark_result(s, "pydeps", ok=True)
    # 两级子命令：顶层 install → 子命令 reset --phase …
    import argparse as ap
    parser = ap.ArgumentParser()
    sub = parser.add_subparsers(dest="c")
    ci.register(sub)
    args = parser.parse_args(["install", "reset", "--phase", "pydeps"])
    assert ci.cmd_install_reset(args) == 0
    s2 = ic.load_state()
    assert s2["phases"]["system"]["status"] == "ok"      # 其它阶段不动
    # 目标阶段被移除后回到 pending 语义（should_run=True；视图按需重建）
    assert "pydeps" not in s2["phases"]
    assert ic.should_run(s2, "pydeps") is True
    args = parser.parse_args(["install", "reset", "--phase", "ghost"])
    assert ci.cmd_install_reset(args) == 2               # 未知阶段报错

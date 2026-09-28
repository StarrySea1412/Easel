"""安装核心（方案功能 D 第一步 / feat/installer-core）。

把 setup.ps1 的线性流程拆成**可重入阶段**：每个阶段有稳定 id、成功判据与
结构化状态。状态写进 <data_dir>/install-state.json，重跑时已成功的阶段跳过
（幂等），失败阶段从断点继续。EXE 引导安装器（后续 ⑦）复用同一核心。

设计要点（对应方案 D 的验收）：
- 阶段结果结构化：{id, title, status: pending|running|ok|skipped|failed,
  lastRun, attempts, detail}，进度/诊断/日志路径都从它来；
- 不静默改写 PATH/profile：需要装系统级工具（winget）的阶段只在用户
  显式允许时执行（allow_winget），否则失败并给出人可读的修复指引；
- 有限重试只针对瞬时故障（网络/超时），权限/版本/配置类错误直接 failed；
- 数据目录独立于源码目录：EASEL_DATA_DIR（默认源码根，发行版引导器会
  指到 %LOCALAPPDATA%/Easel/data），登录态/画像/产物跟着数据目录走，
  从源码运行（开发者）不受影响。
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

STATE_VERSION = 1

# 阶段定义：id 唯一；retriable=哪些失败可自动重试；needs_winget=要装系统级软件
PHASES: list[dict] = [
    {"id": "system", "title": "检查系统环境", "retriable": False, "needs_winget": True},
    {"id": "openclaw", "title": "安装 OpenClaw", "retriable": True, "needs_winget": False},
    {"id": "pydeps", "title": "安装 Python 依赖", "retriable": True, "needs_winget": False},
    {"id": "frontend", "title": "构建 Web 前端", "retriable": True, "needs_winget": False},
    {"id": "chromium", "title": "安装 Playwright Chromium", "retriable": True, "needs_winget": False},
    {"id": "profile", "title": "准备 OpenClaw profile", "retriable": False, "needs_winget": False},
    {"id": "skills", "title": "同步 skills 与 workspace", "retriable": False, "needs_winget": False},
    {"id": "gateway", "title": "启动 Gateway", "retriable": True, "needs_winget": False},
]
_PHASE_IDS = [p["id"] for p in PHASES]

MAX_AUTO_RETRY = 2          # 瞬时故障自动重试上限（方案 D：最多 2–3 次，逐次退避）
RETRY_BACKOFF = (10, 30)    # 每次重试前的等待秒数


def data_dir() -> Path:
    """用户数据目录：EASEL_DATA_DIR 显式指定，否则源码根（开发者现状不变）。"""
    return Path(os.environ.get("EASEL_DATA_DIR", "") or Path(__file__).resolve().parents[1]).resolve()


def state_path(base: Path | None = None) -> Path:
    return (base or data_dir()) / "install-state.json"


def load_state(base: Path | None = None) -> dict:
    """读安装状态；无文件/损坏/版本不符 → 全新状态（绝不因状态损坏拒绝安装）。"""
    p = state_path(base)
    fresh = {"version": STATE_VERSION, "phases": {}}
    if not p.is_file():
        return fresh
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return fresh
    if not isinstance(d, dict) or d.get("version") != STATE_VERSION \
            or not isinstance(d.get("phases"), dict):
        return fresh
    # 只认认识的阶段 id，未知阶段丢弃（阶段定义演进后旧状态自动瘦身）
    d["phases"] = {k: v for k, v in d["phases"].items() if k in _PHASE_IDS and isinstance(v, dict)}
    return d


def save_state(state: dict, base: Path | None = None) -> None:
    p = state_path(base)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def _phase_view(state: dict, pid: str) -> dict:
    return state["phases"].setdefault(
        pid, {"status": "pending", "lastRun": None, "attempts": 0, "detail": ""})


def plan(state: dict) -> list[dict]:
    """下一步执行计划：按定义顺序列出各阶段状态（前端/EXE 展示用）。"""
    out = []
    for p in PHASES:
        v = dict(_phase_view(state, p["id"]))
        v.update({"id": p["id"], "title": p["title"], "retriable": p["retriable"],
                  "needsWinget": p["needs_winget"]})
        out.append(v)
    return out


def should_run(state: dict, pid: str) -> bool:
    """阶段是否需要执行：没跑过 / 上次失败 / 上次 running（进程中断）→ 要跑；
    上次 ok/skipped → 跳过（幂等核心：同版本重复执行不重复安装已满足的组件）。"""
    if pid not in _PHASE_IDS:
        raise ValueError(f"未知阶段：{pid}")
    v = state["phases"].get(pid) or {}
    return v.get("status") not in ("ok", "skipped")


def bind_installation(state: dict, root: Path, version: str) -> dict:
    """成功状态只属于同一发行版本和安装目录；旧版无 identity 也必须重验。"""
    identity = {"root": os.path.normcase(str(root.resolve())), "version": version}
    if state.get("installation") != identity:
        return {"version": STATE_VERSION, "installation": identity, "phases": {}}
    return state


def mark_running(state: dict, pid: str, detail: str = "", base: Path | None = None) -> None:
    v = _phase_view(state, pid)
    v.update({"status": "running", "lastRun": int(time.time()), "detail": detail})
    save_state(state, base)


def mark_result(state: dict, pid: str, ok: bool, detail: str = "",
                auto_retry: bool = False, base: Path | None = None,
                run_attempt: int | None = None) -> dict:
    """记录阶段结果。瞬时失败（网络/超时，由 transient_failure 判定）在重试预算内置
    retry 并逐次退避；预算耗尽或非瞬时错误 → failed 停住（保留可恢复状态，等用户动作）。
    auto_retry 只是「允许自动重试」的开关，是否真重试还看失败原因是否瞬时。
    返回该阶段的新状态（含是否还要重试）。"""
    v = _phase_view(state, pid)
    v["attempts"] = int(v.get("attempts", 0)) + 1
    v["lastRun"] = int(time.time())
    v["detail"] = (detail or "")[:300]
    retriable = transient_failure(detail)
    if ok:
        v["status"] = "ok"
    elif auto_retry and retriable and (run_attempt or v["attempts"]) <= MAX_AUTO_RETRY:
        v["status"] = "retry"
    else:
        v["status"] = "failed"
    save_state(state, base)
    return v


def retry_wait_seconds(attempts: int) -> int:
    """逐次延长等待：第 1 次重试前 10s，第 2 次 30s。"""
    if attempts <= 0:
        return 0
    return RETRY_BACKOFF[min(attempts, len(RETRY_BACKOFF)) - 1]


def transient_failure(detail: str) -> bool:
    """瞬时故障判据：网络/超时/暂时不可用（自动重试只认这些）；
    权限/版本不兼容/配置无效/路径冲突不在此列 → 直接 failed。"""
    d = (detail or "").lower()
    # npm/pip 的版本、权限及配置错误可能也含 network/timeout 字眼，永久错误优先。
    if any(k in d for k in ("access denied", "permission denied", "eacces", "eperm",
                            "ebadengine", "unsupported engine", "unrecognized key",
                            "invalid configuration", "no matching distribution",
                            "could not find a version", "erresolve", "eresolve",
                            "版本不兼容", "配置无效", "权限不足", "路径冲突")):
        return False
    return any(k in d for k in (
        "timed out", "timeout", "etimedout", "econnreset", "econnrefused",
        "eai_again", "network is unreachable", "network error", "暂时", "econnaborted", "epipe",
        "socket hang up",
    )) or bool(re.search(r"\b(?:502|503|504)\b", d))


def winget_allowed(allow_flag: bool | None = None) -> bool:
    """是否允许用 winget 装系统级工具。默认关（不静默改 PATH/装软件）；
    EXE 安装器在用户点了「同意安装系统依赖」后传 True。"""
    if allow_flag is not None:
        return bool(allow_flag)
    env = (os.environ.get("EASEL_INSTALL_ALLOW_WINGET") or "").strip().lower()
    return env in ("1", "true", "yes")


def overall(state: dict) -> dict:
    """整体安装状态摘要：done（全 ok/skipped）/ failed / running / pending。"""
    sts = [_phase_view(state, p["id"]).get("status", "pending") for p in PHASES]
    if "running" in sts or "retry" in sts:
        return {"status": "running", "done": sum(s in ("ok", "skipped") for s in sts),
                "total": len(PHASES)}
    if "failed" in sts:
        return {"status": "failed", "done": sum(s in ("ok", "skipped") for s in sts),
                "total": len(PHASES)}
    if all(s in ("ok", "skipped") for s in sts):
        return {"status": "done", "done": len(PHASES), "total": len(PHASES)}
    return {"status": "pending", "done": sum(s in ("ok", "skipped") for s in sts),
            "total": len(PHASES)}

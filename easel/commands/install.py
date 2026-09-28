"""easel install — 安装核心的阶段视图与管理命令（setup.ps1 之外的机读入口）。

- `easel install status`：打印各阶段状态 + 数据目录与状态文件位置（诊断）。
- `easel install reset [--phase id]`：清掉全部（或单个）阶段状态，让下次安装重跑。
  只动 install-state.json，不卸载任何已装组件。

真正的阶段执行逻辑在 setup.ps1（交互式向导，开发者入口）与后续 EXE 引导器；
本命令提供的是状态/诊断面，与安装脚本共用 easel.install_core 的状态文件。
"""
from __future__ import annotations

import argparse
import sys

from easel import install_core as ic

_STATUS_ICON = {"pending": "·", "running": "▶", "retry": "↻",
                "ok": "✓", "skipped": "—", "failed": "✗"}


def cmd_install_status(_args) -> int:
    state = ic.load_state()
    print("Easel 安装状态\n")
    base = ic.data_dir()
    print(f"  数据目录：{base}")
    print(f"  状态文件：{ic.state_path(base)}")
    print()
    for ph in ic.plan(state):
        line = f"  [{_STATUS_ICON.get(ph['status'], '?')}] {ph['title']}"
        if ph["status"] == "failed" and ph.get("detail"):
            line += f"  ← {ph['detail'][:80]}"
        if ph.get("attempts"):
            line += f"  （第 {ph['attempts']} 次尝试）"
        print(line)
    o = ic.overall(state)
    print(f"\n  总体：{o['status']}（{o['done']}/{o['total']} 阶段完成）")
    return 0 if o["status"] == "done" else 1


def cmd_install_reset(args) -> int:
    state = ic.load_state()
    if args.phase:
        if args.phase not in {p["id"] for p in ic.PHASES}:
            print(f"未知阶段：{args.phase}（可选：{' '.join(p['id'] for p in ic.PHASES)}）",
                  file=sys.stderr)
            return 2
        state["phases"].pop(args.phase, None)
        ic.save_state(state)
        print(f"已重置阶段 {args.phase}，下次安装将重跑它")
        return 0
    ic.save_state({"version": ic.STATE_VERSION, "phases": {}})
    print("已清空安装状态；下次安装将从 system 阶段重新开始（已装组件不受影响，会按需重查）")
    return 0


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser("install", help="安装状态查看/管理（阶段详情见 setup 向导）")
    i = p.add_subparsers(dest="install_cmd", required=True)
    i.add_parser("status", help="查看各阶段安装状态").set_defaults(func=cmd_install_status)
    r = i.add_parser("reset", help="清空（或单个）阶段状态，使其下次重跑")
    r.add_argument("--phase", default=None, help="只重置该阶段（缺省=全部）")
    r.set_defaults(func=cmd_install_reset)

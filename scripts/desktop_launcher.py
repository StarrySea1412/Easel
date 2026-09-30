"""Small graphical launcher for the browser workbench (run with pythonw)."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import webbrowser

from bootstrapper import redact_install_output


def start_workbench(root: Path, data: Path, *, restart: bool = False, reuse_only: bool = False, run=subprocess.run) -> str:
    """Run the verified startup path without a console and return its local URL."""
    python = root / ".venv" / "Scripts" / "python.exe"
    script = root / "scripts" / "start_workspace.py"
    if not python.is_file() or not script.is_file():
        raise RuntimeError("启动文件缺失，请重新运行 Easel 安装器修复。")
    command = [str(python), str(script), "--root", str(root), "--data-dir", str(data), "--no-browser"]
    if restart:
        command.append('--restart')
    elif reuse_only:
        command.append('--reuse-only')
    result = run(command,
                 cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                 env=dict(os.environ, PYTHONUTF8='1'),
                 text=True, encoding="utf-8", errors="replace", timeout=3600 if restart else 480,
                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        detail = redact_install_output((result.stderr or result.stdout or "启动服务失败。").strip(), data)
        raise RuntimeError(detail[-1600:])
    # Do not hand arbitrary tool output or a remote URL to the user's browser.
    lines = (result.stdout or "").strip().splitlines()
    match = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{1,5})/", lines[-1] if lines else "")
    if not match or not 1 <= int(match.group(1)) <= 65535:
        raise RuntimeError("未收到有效的本地工作台地址，请查看启动日志后重试。")
    return match.group(0)


def choose_start_mode(data: Path, confirm) -> str:
    try:
        saved = json.loads((data / '.storage-location.json').read_text(encoding='utf-8'))
        pending = saved.get('pendingPath') if isinstance(saved, dict) else None
    except (OSError, ValueError):
        pending = None
    if not isinstance(pending, str) or not pending.strip():
        return 'normal'
    prompt = (f'内容保存位置将迁移到：\n{pending}\n\n请先结束正在进行的生成、发布和分析任务。\n'
              '选择“是”：重启本安装的工作台并迁移；大量内容可能需要较长时间。\n'
              '选择“否”：仅打开现有工作台，暂不迁移。')
    return 'restart' if confirm(prompt) else 'reuse'


def launch_gui(root: Path, data: Path) -> int:
    import tkinter as tk
    from tkinter import messagebox, ttk

    data.mkdir(parents=True, exist_ok=True)
    (data / "logs").mkdir(exist_ok=True)
    window = tk.Tk()
    window.title("Easel 工作台")
    window.geometry("600x320")
    window.minsize(540, 300)
    window.configure(background="#faf9f6")
    style = ttk.Style(window)
    style.configure("Easel.TFrame", background="#faf9f6")
    style.configure("Easel.TLabel", background="#faf9f6", foreground="#292823", font=("Segoe UI", 10))
    style.configure("EaselTitle.TLabel", background="#faf9f6", foreground="#292823", font=("Segoe UI", 19, "bold"))
    outer = ttk.Frame(window, style="Easel.TFrame", padding=28)
    outer.pack(fill="both", expand=True)
    ttk.Label(outer, text="Easel 工作台", style="EaselTitle.TLabel").pack(anchor="w")
    ttk.Label(outer, text="准备就绪后，将在浏览器中打开你的工作台。", style="Easel.TLabel").pack(anchor="w", pady=(6, 18))
    status = tk.StringVar(value="正在准备启动…")
    detail = tk.StringVar(value="")
    ttk.Label(outer, textvariable=status, style="Easel.TLabel").pack(anchor="w")
    progress = ttk.Progressbar(outer, mode="indeterminate")
    progress.pack(fill="x", pady=(10, 12))
    ttk.Label(outer, textvariable=detail, style="Easel.TLabel", wraplength=540).pack(anchor="w", fill="x")
    buttons = ttk.Frame(outer, style="Easel.TFrame")
    buttons.pack(side="bottom", fill="x", pady=(18, 0))
    events: queue.Queue[tuple[str, str]] = queue.Queue()
    running = False
    ready_url = ""

    def show_logs() -> None:
        try:
            os.startfile(str(data / "logs"))
        except OSError:
            detail.set(f"日志目录：{data / 'logs'}")

    def open_browser() -> None:
        try:
            opened = webbrowser.open(ready_url)
        except OSError:
            opened = False
        if opened:
            status.set("工作台已就绪，浏览器已打开。")
            window.after(1200, window.destroy)
        else:
            status.set("工作台已就绪，请点击“打开浏览器”或复制下方地址。")
            detail.set(ready_url)
            retry.configure(text="打开浏览器", command=open_browser, state="normal")
            copy_button.pack(side="left", padx=(8, 0))

    def copy_url() -> None:
        window.clipboard_clear()
        window.clipboard_append(ready_url)
        status.set("地址已复制，可粘贴到浏览器打开。")

    def begin() -> None:
        nonlocal running
        if running:
            return
        mode = choose_start_mode(data, lambda prompt: messagebox.askyesno('重启并迁移', prompt, parent=window))
        running = True
        status.set("正在启动本地工作台…")
        detail.set("正在重启工作台并迁移内容，请保留此窗口。" if mode == 'restart' else "首次启动可能需要几分钟，正在检查 Gateway 和工作台服务。")
        retry.configure(state="disabled")
        close.configure(state="disabled")
        progress.configure(mode="indeterminate")
        progress.start(12)

        def worker() -> None:
            try:
                events.put(("ready", start_workbench(root, data, restart=mode == 'restart', reuse_only=mode == 'reuse')))
            except subprocess.TimeoutExpired:
                events.put(("error", "启动等待超时。可点击重试，或查看启动日志了解进度。"))
            except Exception as exc:
                events.put(("error", redact_install_output(str(exc), data)[-1600:]))

        threading.Thread(target=worker, daemon=True).start()

    def poll() -> None:
        nonlocal running, ready_url
        try:
            kind, message = events.get_nowait()
        except queue.Empty:
            window.after(150, poll)
            return
        running = False
        progress.stop()
        close.configure(state="normal")
        if kind == "ready":
            ready_url = message
            progress.configure(mode="determinate", value=100)
            detail.set(message)
            open_browser()
        else:
            status.set("工作台暂未启动成功")
            detail.set(message)
            retry.configure(text="重试启动", state="normal", command=begin)
        window.after(150, poll)

    def on_close() -> None:
        if running:
            detail.set("正在启动服务，请等待完成后关闭。启动结果和错误会显示在此窗口。")
        else:
            window.destroy()

    retry = ttk.Button(buttons, text="重试启动", command=begin)
    retry.pack(side="left")
    copy_button = ttk.Button(buttons, text="复制地址", command=copy_url)
    ttk.Button(buttons, text="查看日志", command=show_logs).pack(side="left", padx=(8, 0))
    close = ttk.Button(buttons, text="关闭", command=on_close)
    close.pack(side="right")
    window.protocol("WM_DELETE_WINDOW", on_close)
    window.after(100, begin)
    window.after(150, poll)
    window.mainloop()
    return 0 if ready_url else 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    ap.add_argument("--data-dir", type=Path, required=True)
    args = ap.parse_args(argv)
    return launch_gui(args.root.resolve(), args.data_dir.resolve())


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        # A missing Tk runtime must still produce a visible repair message.
        if os.name == "nt":
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, f"无法打开 Easel 启动窗口：{exc}\n请重新运行安装器修复。", "Easel", 0x10)
        raise SystemExit(1)

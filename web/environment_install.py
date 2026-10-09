"""Bounded, serial environment installs; UI reconnects read the same jobs.

Only the caller's trusted recipe catalog can select a command. No shell text,
interpreter, destination or environment values are accepted from HTTP callers.
"""
from __future__ import annotations

from collections import deque
from copy import deepcopy
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
import uuid

from easel.install_runner import redact, terminate_phase_tree

EVENT_PREFIX = "EASEL_INSTALL_EVENT "
ACTIVE_STATES = {"queued", "running"}
MAX_LOG_LINES = 240


def safe_output(value: str, root: Path, data_dir: Path) -> str:
    value = redact(redact(str(value), root), data_dir)
    # pip/proxy errors can echo credentials embedded in an index URL.
    value = re.sub(r"(?i)(https?://)[^\s/@]+:[^\s/@]+@", r"\1[REDACTED]@", value)
    value = re.sub(r"(?i)([?&](?:token|api_key|apikey|key|password|signature|secret)=)[^\s&#]+",
                   r"\1[REDACTED]", value)
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value).replace("\x00", "")


def failure_help(detail: str) -> tuple[str, str]:
    text = detail.lower()
    if any(word in text for word in ("timeoutexpired", "timed out", "timeout", "超时")):
        return "timeout", "确认网络和磁盘仍可用后重试；每个步骤有独立超时，不会无限等待。"
    if any(word in text for word in ("no space", "disk full", "磁盘空间", "空间不足")):
        return "disk", "释放安装目录或缓存目录的磁盘空间后重试。"
    if any(word in text for word in ("permission", "access is denied", "拒绝访问", "权限")):
        return "permission", "确认解释器和安装目录可写；系统软件可使用其官方安装器完成后重新检测。"
    if any(word in text for word in ("connection", "proxy", "ssl", "certificate", "network", "连接", "网络")):
        return "network", "检查下载源、网络或证书设置后重试；已下载缓存由原安装工具复用。"
    if any(word in text for word in ("not found", "filenotfounderror", "不存在", "no module named")):
        return "missing_tool", "先准备提示中缺少的安装工具或前置依赖，再重试或重新检测。"
    return "install", "查看下方原始错误，处理对应原因后手动重试；已完成步骤会先重新检测。"


class EnvironmentInstalls:
    def __init__(self, script: Path, root: Path, python: str, data_dir: Path, on_finished=None):
        self.script, self.root, self.python, self.data_dir = script, root, python, data_dir
        self.on_finished = on_finished
        self._lock = threading.RLock()
        self._jobs: dict[str, dict] = {}
        self._queue: deque[str] = deque()
        self._worker: threading.Thread | None = None
        self._blocked = ""
        self.server_id = uuid.uuid4().hex[:12]

    def _safe(self, value: str) -> str:
        return safe_output(value, self.root, self.data_dir)

    def _snapshot(self, job: dict) -> dict:
        result = deepcopy(job)
        result["elapsedSeconds"] = max(0, int((job["ended"] or time.time()) - job["started"])) if job["started"] else 0
        result["queuePosition"] = list(self._queue).index(job["jobId"]) + 1 if job["jobId"] in self._queue else 0
        return result

    def list(self) -> dict:
        with self._lock:
            return {"jobs": [self._snapshot(job) for job in self._jobs.values()],
                    "blockedReason": self._blocked, "serverId": self.server_id,
                    "logLimit": MAX_LOG_LINES}

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return self._snapshot(job) if job else None

    def enqueue(self, ids: list[str], catalog: dict[str, dict], retry_of: str | None = None) -> dict:
        ids = list(dict.fromkeys(ids))
        if not ids or any(tid not in catalog for tid in ids):
            raise ValueError("只能安装已登记的工具")
        if any(catalog[tid].get("needs_dir") for tid in ids):
            raise ValueError("该依赖需要具体 Remotion 工程，请在工程初始化流程中安装")
        with self._lock:
            if self._blocked:
                raise RuntimeError(self._blocked)
            previous = self._jobs.get(retry_of) if retry_of else None
            if retry_of and (not previous or ids != [previous["id"]] or previous["state"] != "fail"):
                raise ValueError("只能重试本服务记录的失败安装任务")
            if previous and (previous.get("result") or {}).get("retryable") is False:
                raise ValueError("无法确认旧安装进程已结束，请先处理错误并重启工作台后重新检测")
            accepted = []
            for tid in ids:
                active = next((j for j in self._jobs.values() if j["id"] == tid and j["state"] in ACTIVE_STATES), None)
                if active:
                    accepted.append({**self._snapshot(active), "reused": True})
                    continue
                spec = catalog[tid]
                strategies = spec.get("install") or []
                seconds = min(10800, sum(int(step[2]) if len(step) > 2 else 600 for step in strategies)
                              + 120 * (len(strategies) + 1) + 90)
                now, job_id = time.time(), uuid.uuid4().hex[:16]
                job = {"jobId": job_id, "id": tid, "name": spec.get("name") or tid,
                       "state": "queued", "stage": "queued", "label": "等待前一项完成",
                       "lines": [], "logLineCount": 0, "result": None, "created": now,
                       "started": None, "ended": None, "updated": now, "lastOutputAt": None,
                       "strategyIndex": 0, "strategyCount": len(strategies), "strategy": None,
                       "phaseTimeoutSeconds": None, "timeoutSeconds": seconds,
                       "retryOf": retry_of, "attempt": (previous["attempt"] + 1) if previous else 1}
                self._jobs[job_id] = job
                self._queue.append(job_id)
                accepted.append({**self._snapshot(job), "reused": False})
            # Retain recent terminal results for page reloads; never evict an
            # active job or a just-accepted result.
            terminal = [key for key, job in self._jobs.items() if job["state"] not in ACTIVE_STATES]
            for key in terminal[:max(0, len(self._jobs) - 80)]:
                self._jobs.pop(key, None)
            if self._worker is None or not self._worker.is_alive():
                self._worker = threading.Thread(target=self._work, daemon=True, name="environment-install-queue")
                self._worker.start()
            first = accepted[0]
            return {"jobId": first["jobId"], "id": first["id"], "state": first["state"],
                    "reused": all(job["reused"] for job in accepted), "jobs": accepted}

    def retry(self, job_id: str, catalog: dict[str, dict]) -> dict:
        with self._lock:
            previous = self._jobs.get(job_id)
            if not previous:
                raise ValueError("任务不存在，服务可能已重启；请重新检测环境")
            return self.enqueue([previous["id"]], catalog, retry_of=job_id)

    def _line(self, job: dict, line: str) -> None:
        if line.startswith(EVENT_PREFIX):
            try:
                event = json.loads(line[len(EVENT_PREFIX):])
            except (ValueError, TypeError):
                event = {}
            if event.get("stage") in {"checking", "installing", "verifying", "complete"}:
                with self._lock:
                    job["stage"] = event["stage"]
                    job["label"] = self._safe(str(event.get("label") or event["stage"]))[:200]
                    for key in ("strategyIndex", "strategyCount", "phaseTimeoutSeconds"):
                        if isinstance(event.get(key), int) and 0 <= event[key] <= 10800:
                            job[key] = event[key]
                    if isinstance(event.get("strategy"), str):
                        job["strategy"] = self._safe(event["strategy"])[:200]
                    job["updated"] = time.time()
                return
        clean = self._safe(line).strip()[:2000]
        if clean:
            with self._lock:
                job["lines"] = (job["lines"] + [clean])[-MAX_LOG_LINES:]
                job["logLineCount"] += 1
                job["lastOutputAt"] = job["updated"] = time.time()

    def _work(self):
        while True:
            with self._lock:
                if not self._queue or self._blocked:
                    self._worker = None
                    return
                job = self._jobs[self._queue.popleft()]
                job.update(state="running", stage="checking", label="安装前检测", started=time.time(), updated=time.time())
            try:
                self._execute(job)
            except Exception as exc:  # Keep queue state truthful even for unexpected launch failures.
                self._finish(job, {"state": "fail", "detail": self._safe(f"{type(exc).__name__}: {exc}")})

    def _stop(self, proc):
        if os.name != "nt":
            # The engine's SIGTERM handler first kills its current phase group.
            proc.terminate()
            try:
                proc.wait(timeout=5)
                return
            except subprocess.TimeoutExpired:
                pass
        terminate_phase_tree(proc)
        proc.wait(timeout=10)

    def _execute(self, job: dict):
        command = [self.python, "-u", str(self.script), "--python", self.python,
                   "--json", "--events", "install", job["id"]]
        proc = None
        readers = []
        output: deque[str] = deque(maxlen=64)  # Final JSON only; at most 256 KiB.
        result = None
        try:
            proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, encoding="utf-8", errors="replace", cwd=self.root,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                                    start_new_session=os.name != "nt")

            def stdout():
                for chunk in iter(lambda: proc.stdout.read(4096), ""):
                    output.append(chunk)

            def stderr():
                for line in iter(lambda: proc.stderr.readline(4096), ""):
                    self._line(job, line.rstrip("\r\n"))

            for drain in (stdout, stderr):
                thread = threading.Thread(target=drain, daemon=True)
                thread.start()
                readers.append(thread)
            proc.wait(timeout=job["timeoutSeconds"])
            for reader in readers:
                reader.join(timeout=3)
            try:
                decoded = json.loads("".join(output))
                result = (decoded.get("results") or [None])[0]
                if not isinstance(result, dict) or result.get("id") != job["id"]:
                    result = None
            except (ValueError, TypeError, AttributeError, IndexError):
                pass
            if result is None:
                result = {"state": "fail", "detail": "安装器未返回可验证结果。" +
                          (f"退出码 {proc.returncode}；" if proc.returncode else "") +
                          (job["lines"][-1] if job["lines"] else "请查看安装工具是否可启动。")}
            if proc.returncode != 0:
                result["state"] = "fail"
        except subprocess.TimeoutExpired:
            try:
                self._stop(proc)
                result = {"state": "fail", "kind": "timeout", "detail": f"安装超过 {job['timeoutSeconds']} 秒，已结束安装进程。"}
            except Exception as exc:
                result = {"state": "fail", "kind": "cleanup", "retryable": False,
                          "detail": f"超时安装进程未能确认结束：{exc}"}
        except Exception as exc:
            if proc is not None and proc.poll() is None:
                try:
                    self._stop(proc)
                except Exception as cleanup:
                    result = {"state": "fail", "kind": "cleanup", "retryable": False, "detail": str(cleanup)}
            result = result or {"state": "fail", "detail": f"{type(exc).__name__}: {exc}"}
        finally:
            for reader in readers:
                reader.join(timeout=1)
        self._finish(job, result)

    def _finish(self, job: dict, result: dict):
        # Only expose expected scalar result fields, scrubbed before storage.
        safe = {"id": job["id"], "state": "ok" if result.get("state") == "ok" else "fail",
                "detail": self._safe(str(result.get("detail") or ""))[:4000],
                "version": self._safe(str(result.get("version") or ""))[:200],
                "strategy": self._safe(str(result.get("strategy") or ""))[:200],
                "retryable": result.get("retryable") is not False}
        if safe["state"] == "fail":
            kind, help_text = failure_help(safe["detail"])
            safe.update(kind=result.get("kind") if result.get("kind") in {"timeout", "cleanup"} else kind,
                        nextStep=help_text)
        with self._lock:
            job.update(state=safe["state"], stage="complete" if safe["state"] == "ok" else "failed",
                       label="校验通过" if safe["state"] == "ok" else "安装失败",
                       result=safe, ended=time.time(), updated=time.time())
            if not safe["retryable"]:
                self._blocked = "无法确认旧安装进程已结束，已停止队列；请处理进程后重启工作台并重新检测。"
                for queued_id in list(self._queue):
                    queued = self._jobs[queued_id]
                    queued.update(state="fail", stage="failed", label="队列已停止", ended=time.time(), updated=time.time(),
                                  result={"id": queued["id"], "state": "fail", "detail": self._blocked, "retryable": False})
                self._queue.clear()
        if self.on_finished:
            self.on_finished()

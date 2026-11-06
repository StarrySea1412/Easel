"""Authenticated binary file transport for Qizhi; never expose its key in URLs.

This backend client is intentionally separate from local chat attachments. A
caller must explicitly upload a file and pass the returned remote relative path.
"""
from __future__ import annotations

from contextlib import ExitStack
from pathlib import Path
import re

import httpx

from .harnesses.base import HarnessError
from .harnesses.qizhi import config

MAX_FILE_BYTES = 209715200


def output_path(value: str) -> str:
    if (not isinstance(value, str) or "\\" in value or "\x00" in value
            or any(ord(c) < 32 for c in value)
            or not value.startswith("outputs/")
            or any(part in ("", ".", "..") for part in value.split("/"))):
        raise HarnessError("Qizhi 成果路径必须是 outputs/ 内的相对文件路径。")
    return value


class QizhiFiles:
    def __init__(self, env):
        self.base, self.project, _, self._key = config(env)

    def _client(self):
        return httpx.AsyncClient(headers={"X-API-Key": self._key},
                                 timeout=httpx.Timeout(600, connect=10),
                                 trust_env=False, follow_redirects=False)

    @staticmethod
    def _check(response):
        if response.status_code not in (200, 201):
            raise HarnessError(f"Qizhi 文件接口返回 HTTP {response.status_code}，未自动重试。")

    async def upload(self, paths: list[Path]) -> list[dict]:
        if not 1 <= len(paths) <= 8:
            raise HarnessError("Qizhi 每次需要上传 1 至 8 个文件。")
        with ExitStack() as stack:
            files = []
            for path in paths:
                path = Path(path)
                if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
                    raise HarnessError("Qizhi 上传文件不存在或超过 200 MiB。")
                files.append(("files", (path.name, stack.enter_context(path.open("rb")),
                                         "application/octet-stream")))
            try:
                async with self._client() as client:
                    response = await client.post(self.base + "/api/qizhi-agent/files", files=files)
                self._check(response)
                result = response.json()
                rows = result.get("files")
                if (result.get("projectPath") != self.project or not isinstance(rows, list)
                        or len(rows) != len(paths)):
                    raise ValueError
                for row in rows:
                    relative = row.get("relative_path", "")
                    if (not re.fullmatch(r"file_[A-Za-z0-9-]+", row.get("file_id", ""))
                            or not relative.startswith("uploads/") or "\\" in relative
                            or any(p in ("", ".", "..") for p in relative.split("/"))
                            or type(row.get("size")) is not int):
                        raise ValueError
                return rows
            except httpx.HTTPError:
                raise HarnessError("Qizhi 上传连接失败；请核查远端结果，未自动重试。") from None
            except (ValueError, TypeError, AttributeError):
                raise HarnessError("Qizhi 上传回执格式不正确。") from None

    async def artifacts(self, task_id: str) -> dict:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", task_id):
            raise HarnessError("Qizhi 任务 ID 无效。")
        try:
            async with self._client() as client:
                response = await client.get(self.base + "/api/qizhi-agent/artifacts")
            self._check(response)
            result = response.json()
            if result.get("projectPath") != self.project or not isinstance(result.get("artifacts"), list):
                raise ValueError
            prefix = "outputs/" + task_id + "/"
            rows = [row for row in result["artifacts"] if isinstance(row, dict)
                    and isinstance(row.get("relative_path"), str)
                    and row["relative_path"].startswith(prefix)]
            for row in rows:
                output_path(row["relative_path"])
            return {"artifacts": rows, "truncated": bool(result.get("truncated"))}
        except httpx.HTTPError:
            raise HarnessError("Qizhi 成果列表连接失败。") from None
        except (ValueError, TypeError, AttributeError):
            raise HarnessError("Qizhi 成果列表格式不正确。") from None

    async def download(self, relative: str, destination: Path, *, uploaded=False) -> Path:
        if uploaded:
            if not re.fullmatch(r"file_[A-Za-z0-9-]+", relative):
                raise HarnessError("Qizhi 上传文件 ID 无效。")
            endpoint, params = "/api/qizhi-agent/files/" + relative, None
        else:
            endpoint, params = "/api/qizhi-agent/artifacts/file", {"path": output_path(relative)}
        destination = Path(destination)
        temporary = destination.with_name(destination.name + ".part")
        if destination.exists() or temporary.exists():
            raise HarnessError("下载目标已存在，请选择新路径。")
        destination.parent.mkdir(parents=True, exist_ok=True)
        created = False
        try:
            async with self._client() as client:
                async with client.stream("GET", self.base + endpoint, params=params) as response:
                    self._check(response)
                    if ("json" in response.headers.get("content-type", "").lower()
                            and not response.headers.get("content-disposition", "").lower().startswith("attachment")):
                        raise HarnessError("Qizhi 下载返回 JSON 而非原文件，未保存为成果。")
                    size = 0
                    with temporary.open("xb") as handle:
                        created = True
                        async for chunk in response.aiter_bytes():
                            size += len(chunk)
                            if size > MAX_FILE_BYTES:
                                raise HarnessError("Qizhi 下载超过当前 200 MiB 上限。")
                            handle.write(chunk)
                    length = response.headers.get("content-length")
                    if length is not None and size != int(length):
                        raise HarnessError("Qizhi 下载长度不完整。")
            # A hard link publishes without overwriting a concurrent destination.
            destination.hardlink_to(temporary)
            return destination
        except (httpx.HTTPError, ValueError):
            raise HarnessError("Qizhi 下载失败或不完整，未生成最终文件。") from None
        finally:
            if created:
                temporary.unlink(missing_ok=True)

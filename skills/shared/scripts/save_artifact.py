#!/usr/bin/env python3
"""Copy a real file or download HTTP(S) content into Easel's persistent outputs.

Uses EASEL_DATA_DIR via output_paths, so relocated portable copies keep files.
Downloads save the received bytes; an HTML download is not a full offline site.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from output_paths import OUTPUTS_DIR, validate_output_path

MAX_BYTES = 100 * 1024 * 1024


def save_artifact(source: str, output: str) -> dict:
    target = validate_output_path(output, create_parent=True)
    if target.exists():
        raise ValueError('目标已存在，请使用另一个文件名，未覆盖原文件')
    remote = urlsplit(source).scheme.lower() in ('http', 'https')
    if remote:
        parsed = urlsplit(source)
        if not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('下载地址无效或含嵌入凭据')
        incoming = urlopen(Request(source, headers={'User-Agent': 'Easel artifact saver'}), timeout=60)
    else:
        incoming = Path(source).expanduser().open('rb')
    digest = hashlib.sha256()
    total = 0
    temporary = None
    try:
        with incoming, tempfile.NamedTemporaryFile(dir=target.parent, suffix='.partial', delete=False) as stream:
            temporary = Path(stream.name)
            while chunk := incoming.read(64 * 1024):
                total += len(chunk)
                if total > MAX_BYTES:
                    raise ValueError('文件超过 100 MiB，未保存')
                digest.update(chunk)
                stream.write(chunk)
        if not total:
            raise ValueError('文件为空，未保存')
        # Atomic creation without overwriting a concurrently created file.
        try:
            os.link(temporary, target)
        except FileExistsError:
            raise
        except OSError:
            # Portable data may live on a filesystem without hard-link support.
            with target.open('xb') as final:
                try:
                    with temporary.open('rb') as saved:
                        shutil.copyfileobj(saved, final)
                except Exception:
                    final.close()
                    target.unlink(missing_ok=True)
                    raise
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    relative = target.relative_to(OUTPUTS_DIR.resolve()).as_posix()
    return {'saved': True, 'path': f'outputs/{relative}', 'bytes': total, 'sha256': digest.hexdigest()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, help='实际本地文件路径或 HTTP(S) 下载地址')
    parser.add_argument('--output', required=True, help='outputs/<具体主题>/<文件名>')
    args = parser.parse_args()
    try:
        print(json.dumps(save_artifact(args.source, args.output), ensure_ascii=False))
        return 0
    except Exception as exc:
        # URL errors can contain tokens: never echo the source or raw exception.
        print(json.dumps({'saved': False, 'error': type(exc).__name__, 'message': '未保存文件，请检查来源可达性、文件大小、目标路径和是否重名。'}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())

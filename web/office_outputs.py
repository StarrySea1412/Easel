"""Bounded, metadata-only view of public workspace output files.

Project manifests do not prove which session or Agent created a file. This
endpoint deliberately reports workspace scope and never inspects file bodies.
"""
from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import re
import stat
from urllib.parse import quote

MAX_ITEMS = 20
MAX_ENTRIES = 2500
MAX_DIRECTORIES = 128
MAX_DEPTH = 5
KINDS = {
    'image': {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif'},
    'video': {'.mp4', '.mov', '.webm', '.m4v', '.mkv'},
    'audio': {'.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'},
    'text': {'.txt', '.md', '.html', '.htm', '.srt', '.vtt'},
    'document': {'.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.tsv'},
    'archive': {'.zip'},
}
EXTENSIONS = {extension: kind for kind, extensions in KINDS.items() for extension in extensions}
PRIVATE_NAME = re.compile(
    r'(?:^|[. _-])(?:credentials?|cookies?|tokens?|secrets?|passwords?|passwd|auth|login|'
    r'config|sessions?|profiles?|browser|api[ _-]?keys?)(?:$|[. _-])|密钥|凭据|密码|登录状态', re.I)


def _public_name(name: str) -> bool:
    return bool(name) and not name.startswith(('.', '_')) and not PRIVATE_NAME.search(name)


def snapshot(outputs: Path) -> dict:
    warnings: set[str] = set()
    items: list[dict] = []
    truncated = False
    scanned = directories = 0
    try:
        root = outputs.resolve(strict=True)
    except FileNotFoundError:
        root = None
    except OSError:
        root = None
        truncated = True
        warnings.add('内容目录暂不可读，近期产出可能不完整。')
    queue = deque([(root, 0)]) if root is not None else deque()
    while queue:
        if scanned >= MAX_ENTRIES or directories >= MAX_DIRECTORIES:
            truncated = True
            break
        directory, depth = queue.popleft()
        directories += 1
        try:
            # Recheck queued directories before opening them: a child must not
            # become a link or move outside the configured output root.
            if directory != root:
                info = directory.lstat()
                if (stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400
                        or not directory.resolve().is_relative_to(root)):
                    continue
            children = []
            with os.scandir(directory) as entries:
                for entry in entries:
                    if scanned >= MAX_ENTRIES:
                        truncated = True
                        break
                    scanned += 1
                    if not _public_name(entry.name) or depth == 0 and entry.name.casefold() == 'analytics':
                        continue
                    try:
                        info = entry.stat(follow_symlinks=False)
                        if (stat.S_ISLNK(info.st_mode)
                                or getattr(info, 'st_file_attributes', 0) & (0x2 | 0x4 | 0x400)):
                            continue
                        path = Path(entry.path)
                        resolved = path.resolve(strict=True)
                        if not resolved.is_relative_to(root):
                            continue
                        if stat.S_ISDIR(info.st_mode):
                            if depth >= MAX_DEPTH:
                                truncated = True
                            else:
                                children.append((path, depth + 1, info.st_mtime_ns))
                            continue
                        # Root-level files are system residue under the output
                        # contract. Only ordinary files in project directories
                        # with known content extensions are public candidates.
                        kind = EXTENSIONS.get(path.suffix.lower())
                        if depth == 0 or not stat.S_ISREG(info.st_mode) or kind is None:
                            continue
                        rel = path.relative_to(root).as_posix()
                        item = {'id': hashlib.sha256(rel.encode()).hexdigest()[:24], 'name': entry.name,
                                'path': rel, 'kind': kind, 'size': info.st_size,
                                'modifiedAt': datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat(),
                                'href': '/api/media/' + quote(rel, safe='/')}
                        items.append(item)
                        items.sort(key=lambda value: (value['modifiedAt'], value['path']), reverse=True)
                        del items[MAX_ITEMS:]
                    except (OSError, ValueError, OverflowError):
                        truncated = True
                        warnings.add('部分产出暂不可读或已变化，本次已跳过。')
            # Prefer recently modified directories within the bounded scan.
            queue.extend((path, child_depth) for path, child_depth, _ in sorted(children, key=lambda item: item[2], reverse=True))
        except OSError:
            truncated = True
            warnings.add('部分内容目录暂不可读，近期产出可能不完整。')
    if truncated:
        warnings.add('本次仅展示有界扫描内的近期产出，可能未覆盖全部文件。')
    return {
        'scope': 'workspace', 'source': 'local_output_metadata',
        'observedAt': datetime.now(timezone.utc).isoformat(), 'items': items,
        'truncated': truncated, 'warnings': sorted(warnings),
        'detail': '全工作区近期内容文件，仅核对文件元数据；未验证成品状态，也不能归属到当前会话或某位 Agent。',
    }

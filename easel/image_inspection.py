"""Stage one session-owned image for the existing native image tool.

No model request, generation, delivery registration or directory allowlist change.
"""
from __future__ import annotations
import hashlib
import os
from pathlib import Path
import sqlite3

from .artifacts import file_path, scope
from .artifact_writer import _atomic, _directory

MAX_IMAGE_BYTES = 20 * 1024 * 1024


def stage_owned_image(outputs: Path, state: Path, session: str, source: str) -> Path:
    scope(session)
    outputs = Path(outputs).resolve()
    source_path, relative = file_path(outputs, source)
    if source_path.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.gif', '.webp'}:
        raise ValueError('Unsupported image type')
    registry = outputs / '_artifacts' / 'registry.sqlite3'
    if not registry.is_file() or registry.is_symlink() or registry.parent.is_symlink():
        raise ValueError('Image delivery registry unavailable')
    db = sqlite3.connect(registry.as_uri() + '?mode=ro', uri=True, timeout=1)
    try:
        db.execute('PRAGMA query_only=ON')
        owned = db.execute('SELECT 1 FROM artifacts a JOIN deliveries d ON a.id=d.artifact '
                           'WHERE a.session=? AND d.session=? AND a.path=? LIMIT 1',
                           (session, session, relative)).fetchone()
        if not owned:
            raise ValueError('Image is not delivered to this session')
    finally:
        db.close()
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    with os.fdopen(os.open(source_path, flags), 'rb') as handle:
        before = os.fstat(handle.fileno())
        if not 0 < before.st_size <= MAX_IMAGE_BYTES:
            raise ValueError('Image exceeds inspection size limit')
        content = handle.read(MAX_IMAGE_BYTES + 1)
        after = os.fstat(handle.fileno())
        if len(content) != before.st_size or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError('Image changed while reading')
    from io import BytesIO
    from PIL import Image
    with Image.open(BytesIO(content)) as image:
        if image.format not in {'PNG', 'JPEG', 'GIF', 'WEBP'}:
            raise ValueError('Unsupported image content')
        image.verify()
    scope_hash = hashlib.sha256(session.encode()).hexdigest()[:20]
    folder = _directory(Path(state).resolve() / 'media' / 'easel-attachments' / scope_hash)
    target = folder / (hashlib.sha256(content).hexdigest() + source_path.suffix.lower())
    if target.is_symlink():
        raise ValueError('Untrusted inspection target')
    if target.exists():
        if target.read_bytes() != content:
            raise ValueError('Inspection target does not match content')
        return target
    _atomic(target, content)
    return target

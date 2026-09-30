"""Validated, persistent local reference images for Images edits requests."""
from __future__ import annotations

import io
import re
import uuid
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 40_000_000


def reference_path(directory: Path, identifier: str) -> Path:
    if not isinstance(identifier, str) or not re.fullmatch(r"[0-9a-f]{32}", identifier):
        raise ValueError("参考图标识无效，请重新上传")
    path = directory / f"{identifier}.png"
    if path.is_symlink() or not path.is_file() or path.resolve().parent != directory.resolve():
        raise FileNotFoundError("参考图不存在，请重新上传")
    return path


def store_reference(directory: Path, data: bytes, name: str) -> dict:
    if not data or len(data) > MAX_BYTES:
        raise ValueError("参考图需为 10 MB 以内的 PNG、JPEG 或 WebP 图片")
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.format not in {"PNG", "JPEG", "WEBP"}:
                raise ValueError("只支持 PNG、JPEG 或 WebP 图片")
            if source.width * source.height > MAX_PIXELS:
                raise ValueError("图片像素过大，最多支持 4000 万像素")
            if getattr(source, "n_frames", 1) != 1:
                raise ValueError("请使用静态图片，不支持动画参考图")
            source.load()
            normalized = ImageOps.exif_transpose(source).convert("RGBA")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("图片无法解码，请使用有效的 PNG、JPEG 或 WebP") from exc
    identifier = uuid.uuid4().hex
    directory.mkdir(parents=True, exist_ok=True)
    normalized.save(directory / f"{identifier}.png", format="PNG")
    return {"id": identifier, "url": f"/api/imagegen/references/{identifier}",
            "name": Path(name.replace("\\", "/")).name[:150] or "参考图.png",
            "width": normalized.width, "height": normalized.height}


def validate_mask(reference: Path, mask: Path) -> None:
    with Image.open(reference) as original, Image.open(mask) as overlay:
        if overlay.size != original.size:
            raise ValueError("蒙版尺寸必须与参考图一致")
        if "A" not in overlay.getbands() or overlay.getchannel("A").getextrema()[0] != 0:
            raise ValueError("蒙版需要包含完全透明区域；透明区域代表需要编辑的位置")

"""Export an observed login QR at its own size, with a white scan margin.

Detection uses the existing OpenCV dependency and deliberately never decodes
the login ticket. An unrecognised page is labelled as a page preview.
"""
from __future__ import annotations

import base64
import io
import math
import os
import tempfile
from pathlib import Path


def _store(image, path: Path) -> dict:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    content = buffer.getvalue()
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.is_file() or path.read_bytes() != content:
        fd, temporary = tempfile.mkstemp(dir=path.parent, suffix=".png")
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(content)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return {"qrWidth": image.width, "qrHeight": image.height}


def _export(content: bytes, path: Path, *, allow_page: bool = False) -> dict | None:
    from PIL import Image, ImageOps

    if len(content) > 20_000_000:
        return None
    with Image.open(io.BytesIO(content)) as source:
        if source.width > 8192 or source.height > 8192:
            return None
        rgba = source.convert("RGBA")
        image = Image.new("RGB", source.size, "white")
        image.paste(rgba, mask=rgba.getchannel("A"))
    bounds = None
    try:
        import cv2
        import numpy as np

        pixels = np.asarray(image)
        detector = cv2.QRCodeDetector()
        # Tiny CSS-rendered codes need a larger detection view. Preserve the
        # original pixels for the exported image rather than resampling them.
        for scale in (1, 2, 3):
            if max(image.size) * scale > 8192:
                break
            view = pixels if scale == 1 else cv2.resize(pixels, None, fx=scale, fy=scale,
                                                       interpolation=cv2.INTER_NEAREST)
            found, points = detector.detect(view)
            if found and points is not None:
                points = points.reshape(-1, 2) / scale
                bounds = (int(points[:, 0].min()), int(points[:, 1].min()),
                          int(points[:, 0].max()) + 1, int(points[:, 1].max()) + 1)
                break
    except Exception:
        pass
    if bounds is not None:
        code = image.crop(bounds)
        # The independent white margin remains usable on a coloured page or
        # when the platform's DOM clips the QR's original quiet zone.
        # Version 1 has the fewest modules (21); this conservative margin
        # guarantees at least the standard four-module quiet zone for any QR.
        margin = max(12, math.ceil(max(code.size) * 4 / 21))
        return {"qrKind": "qr", **_store(ImageOps.expand(code, border=margin, fill="white"), path)}
    if allow_page:
        return {"qrKind": "page", **_store(image, path)}
    return None


def capture_element(element, path: Path, *, timeout: int = 1500) -> dict | None:
    """Use an official data-image at natural resolution, else its DOM pixels."""
    try:
        if not element.is_visible():
            return None
        tag = (element.evaluate("e => e.tagName") or "").lower()
        if tag == "img":
            if not element.evaluate("e => e.complete && e.naturalWidth > 0 && e.naturalHeight > 0"):
                return None
            src = element.get_attribute("src") or ""
        elif tag == "canvas":
            try:
                src = element.evaluate("e => e.toDataURL('image/png')") or ""
            except Exception:
                src = ""  # Tainted canvas: retain the observed-pixel fallback.
        else:
            src = ""
        if src.startswith("data:image/") and ";base64," in src and len(src) <= 28_000_000:
            try:
                exported = _export(base64.b64decode(src.split(",", 1)[1], validate=True), path)
                if exported:
                    return exported
            except (ValueError, OSError):
                pass
        return _export(element.screenshot(timeout=timeout, type="png"), path)
    except Exception:
        return None  # A navigating/hidden element is not a ready QR.


def capture_page(page, path: Path) -> dict:
    """Crop a detected code; otherwise export a clearly typed page preview."""
    result = _export(page.screenshot(type="png"), path, allow_page=True)
    if result is None:
        raise RuntimeError("登录页面图像无法读取")
    return result

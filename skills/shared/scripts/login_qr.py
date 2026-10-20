"""Export an observed login QR at its own size, with a white scan margin.

Detection uses the existing OpenCV dependency and deliberately never decodes
the login ticket. An unrecognised page is labelled as a page preview.

Two entry styles coexist: the element/page capture helpers used by
web_publisher (return QR metadata for login_state), and the selector-driven
save_qr/capture_qr/prepare_qr helpers shared with xhs_publish.
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


def save_qr(image_bytes: bytes, output: Path, *, minimum_size: int = 0) -> bool:
    """只检测二维码位置，不解码或记录其中的登录令牌。"""
    import cv2
    import numpy as np
    from PIL import Image, ImageOps

    source = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    image = Image.new("RGBA", source.size, "white")
    image.alpha_composite(source)
    image = image.convert("RGB")
    image = ImageOps.expand(image, border=max(8, math.ceil(max(image.size) * 0.12)), fill="white")
    pixels = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2GRAY)
    detector = cv2.QRCodeDetector()
    found, points = detector.detect(pixels)
    if not found and min(image.size) < 320:
        found, points = detector.detect(cv2.resize(
            pixels, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST))
        if found:
            points = points / 2
    if not found or points is None:
        return False
    corners = points.reshape(-1, 2)
    left = max(0, math.floor(float(corners[:, 0].min())))
    top = max(0, math.floor(float(corners[:, 1].min())))
    right = min(image.width, math.ceil(float(corners[:, 0].max())) + 1)
    bottom = min(image.height, math.ceil(float(corners[:, 1].max())) + 1)
    if right <= left or bottom <= top:
        return False
    if min(right - left, bottom - top) < minimum_size:
        return False
    cropped = image.crop((left, top, right, bottom))
    padding = max(8, math.ceil(max(cropped.size) * 0.12))
    cropped = ImageOps.expand(cropped, border=padding, fill="white")
    if min(cropped.size) < 360:
        scale = 360 / min(cropped.size)
        cropped = cropped.resize(
            (round(cropped.width * scale), round(cropped.height * scale)),
            Image.Resampling.NEAREST)
    output.parent.mkdir(parents=True, exist_ok=True)
    encoded = io.BytesIO()
    cropped.save(encoded, format="PNG")
    png_bytes = encoded.getvalue()
    try:
        if output.read_bytes() == png_bytes:
            return True
    except FileNotFoundError:
        pass
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, prefix=f".{output.name}.",
                                         suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(png_bytes)
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return True


def capture_qr(page, output: Path, selectors: str, *, attempts: int = 3,
               minimum_size: int = 0) -> None:
    """遍历可见图片/画布及二维码容器，等待实际像素就绪后裁剪。"""
    candidates = [selector.strip() for selector in selectors.split(",") if selector.strip()]
    leaf_selectors = [f"{selector} img, {selector} canvas" for selector in candidates]
    selector_list = leaf_selectors + candidates
    for attempt in range(attempts):
        seen = set()
        for selector in selector_list:
            try:
                elements = page.query_selector_all(selector)
            except Exception:
                continue
            for element in elements:
                try:
                    if not element.is_visible():
                        continue
                    bounds = element.bounding_box()
                    if not bounds or min(bounds["width"], bounds["height"]) < 48:
                        continue
                    if max(bounds["width"], bounds["height"]) > 1200:
                        continue
                    image_bytes = element.screenshot(timeout=3000, animations="disabled")
                    if image_bytes in seen:
                        continue
                    seen.add(image_bytes)
                    if save_qr(image_bytes, output, minimum_size=minimum_size):
                        return
                except Exception:
                    continue
        if attempt < attempts - 1:
            page.wait_for_timeout(800)
    raise RuntimeError("未找到可识别的登录二维码；页面可能尚未加载、被平台拦截或需要切换扫码登录")


def prepare_qr(page, output: Path, selectors: str, switch_selectors: str, *,
               minimum_size: int = 0) -> None:
    """已有可识别二维码时不点击切换控件，以免切回短信登录。"""
    try:
        page.wait_for_selector(f"{selectors}, {switch_selectors}", timeout=15000, state="visible")
    except Exception:
        pass
    try:
        capture_qr(page, output, selectors, minimum_size=minimum_size)
        return
    except RuntimeError as error:
        missing = error
    for element in page.query_selector_all(switch_selectors):
        if element.is_visible():
            element.click(timeout=3000)
            try:
                page.wait_for_selector(selectors, timeout=15000, state="visible")
            except Exception:
                pass
            capture_qr(page, output, selectors, minimum_size=minimum_size)
            return
    raise missing

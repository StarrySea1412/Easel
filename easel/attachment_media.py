"""Copy validated chat images into the runtime's allowed media directory."""
import hashlib
import os
from pathlib import Path
import tempfile


def stage_image(source, state, scope):
    source = Path(source)
    if source.is_symlink() or not source.is_file() or source.stat().st_size > 20 * 1024 * 1024:
        raise ValueError('图片附件不可读或超过20MiB')
    data = source.read_bytes()
    from PIL import Image
    import io
    with Image.open(io.BytesIO(data)) as image:
        image.verify()
    root = Path(state).resolve()
    root.mkdir(parents=True, exist_ok=True)
    folder = root / 'media' / 'easel-attachments' / scope
    for parent in [root / 'media', root / 'media/easel-attachments', folder]:
        if parent.is_symlink():
            raise ValueError('图片暂存目录不安全')
        parent.mkdir(exist_ok=True)
    target = folder / (hashlib.sha256(data).hexdigest() + source.suffix.lower())
    if target.is_symlink():
        raise ValueError('图片暂存路径不安全')
    if not target.exists() or target.read_bytes() != data:
        fd, temporary = tempfile.mkstemp(dir=folder, prefix='.stage-')
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
    return target

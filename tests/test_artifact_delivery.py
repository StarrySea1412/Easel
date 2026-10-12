import importlib.util
import io
from pathlib import Path
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web


def test_output_metadata_checks_real_files_and_data_root(tmp_path, monkeypatch):
    outputs = tmp_path / 'portable-data' / 'outputs'
    topic = outputs / '实际主题'; topic.mkdir(parents=True)
    (topic / '报告.docx').write_bytes(b'fixture-file')
    (topic / '空文件.txt').touch()
    monkeypatch.setattr(web, 'OUTPUTS_DIR', outputs)
    assert web.api_output_status('实际主题/报告.docx')['exists']
    assert not web.api_output_status('实际主题/不存在.docx')['exists']
    assert not web.api_output_status('实际主题/空文件.txt')['exists']
    with pytest.raises(HTTPException) as exc:
        web.api_output_status('../../secret.txt')
    assert exc.value.status_code == 403


def test_root_artifact_is_visible_in_library_without_private_journals(tmp_path, monkeypatch):
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path)
    (tmp_path / 'actual.txt').write_text('actual local file', encoding='utf-8')
    (tmp_path / '_execution').mkdir()
    (tmp_path / '_execution' / 'state.json').write_text('{}')
    (tmp_path / '.private.txt').write_text('hidden')
    tree = web.get_output_tree()
    assert len(tree) == 1 and tree[0]['path'] == 'actual.txt'
    assert tree[0]['type'] == 'file' and tree[0]['kind'] == 'text'


@pytest.fixture
def saver(tmp_path, monkeypatch):
    scripts = Path(__file__).resolve().parents[1] / 'skills/shared/scripts'
    monkeypatch.syspath_prepend(str(scripts))
    import output_paths
    monkeypatch.setattr(output_paths, 'PROJECT_ROOT', tmp_path / 'portable-data')
    monkeypatch.setattr(output_paths, 'OUTPUTS_DIR', tmp_path / 'portable-data/outputs')
    spec = importlib.util.spec_from_file_location('test_artifact_saver', scripts / 'save_artifact.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def test_local_files_are_saved_in_portable_data_without_overwriting(saver, tmp_path):
    source = tmp_path / 'source.docx'; source.write_bytes(b'real file bytes')
    result = saver.save_artifact(str(source), 'outputs/实际主题/文案.docx')
    assert result['saved'] and result['path'] == 'outputs/实际主题/文案.docx'
    assert (tmp_path / 'portable-data' / result['path']).read_bytes() == source.read_bytes()
    with pytest.raises(ValueError):
        saver.save_artifact(str(source), result['path'])
    assert not list((tmp_path / 'portable-data/outputs').rglob('*.partial'))


def test_downloads_save_received_bytes_and_failures_leave_no_delivery(saver, tmp_path, monkeypatch):
    monkeypatch.setattr(saver, 'urlopen', lambda *a, **k: io.BytesIO(b'<html>actual page snapshot</html>'))
    result = saver.save_artifact('https://example.test/page', 'outputs/网页存档/页面.html')
    assert (tmp_path / 'portable-data' / result['path']).read_bytes().startswith(b'<html>')
    monkeypatch.setattr(saver, 'urlopen', lambda *a, **k: io.BytesIO(b''))
    with pytest.raises(ValueError):
        saver.save_artifact('https://example.test/empty', 'outputs/网页存档/空.html')
    assert not (tmp_path / 'portable-data/outputs/网页存档/空.html').exists()
    assert not list((tmp_path / 'portable-data/outputs').rglob('*.partial'))


def test_portable_filesystem_without_hardlinks_preserves_bytes_and_existing_targets(saver, tmp_path, monkeypatch):
    source = tmp_path / 'source.txt'; source.write_bytes(b'portable bytes')
    def no_hardlinks(*args):
        raise OSError('filesystem does not support hard links')
    monkeypatch.setattr(saver.os, 'link', no_hardlinks)
    result = saver.save_artifact(str(source), 'outputs/真实下载/备份.txt')
    target = tmp_path / 'portable-data' / result['path']
    assert target.read_bytes() == source.read_bytes()
    with pytest.raises(ValueError):
        saver.save_artifact(str(source), result['path'])
    assert target.read_bytes() == source.read_bytes()
    monkeypatch.setattr(saver, 'MAX_BYTES', 2)
    with pytest.raises(ValueError):
        saver.save_artifact(str(source), 'outputs/真实下载/超过上限.txt')
    assert not (target.parent / '超过上限.txt').exists()
    assert not list(target.parent.glob('*.partial'))

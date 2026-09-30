"""Generated images and pre-existing history share the content library, without live providers."""
import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'web')]
import app as web


@pytest.fixture
def library(tmp_path, monkeypatch):
    outputs = tmp_path / 'outputs'
    outputs.mkdir()
    monkeypatch.setattr(web, 'OUTPUTS_DIR', outputs)
    monkeypatch.setattr(web, 'IMAGEGEN_DIR', outputs / 'AI生图')
    monkeypatch.setattr(web, '_IMAGEGEN_JOBS', {})
    monkeypatch.setattr(web, '_read_env', lambda: {
        'IMG_BASE_URL': 'https://images.example.test/v1',
        'IMG_MODEL': 'test-image', 'IMG_API_KEY': 'secret-test-value',
    })
    return outputs


def save_image(path, dimensions=(90, 160)):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new('RGB', dimensions).save(path)
    return path


def flatten(nodes):
    return [file for node in nodes for file in
            (flatten(node.get('children', [])) if node['type'] == 'dir' else [node])]


def test_library_keeps_every_old_and_new_image_without_moving_files(library):
    paths = [save_image(library / 'images' / f'old-{index}.png') for index in range(14)]
    paths += [save_image(web.IMAGEGEN_DIR / 'new.webp', (160, 90))]
    save_image(library / '客户项目' / 'cover.png')
    save_image(library / '_inbox' / 'private.png')
    nodes = web.api_outputs()
    generated = [node for node in flatten(nodes) if node.get('source') == 'imagegen']
    assert len(generated) == 15  # Content library is not limited by the old 12-image gallery.
    assert {node['path'] for node in generated} == {path.relative_to(library).as_posix() for path in paths}
    assert all(path.exists() for path in paths)
    assert next(node for node in generated if node['name'] == 'new.webp')['width'] == 160
    assert all('generation' not in node for node in generated)
    assert all(not node['path'].startswith('_inbox/') for node in flatten(nodes))
    assert not next(node for node in flatten(nodes) if node['name'] == 'cover.png').get('source')


def test_legacy_gallery_works_when_only_old_images_exist(library):
    save_image(library / 'images' / 'legacy.jpg')
    result = asyncio.run(web.api_imagegen_gallery())
    assert result['images'][0]['url'] == '/api/media/images/legacy.jpg'
    assert (result['images'][0]['width'], result['images'][0]['height']) == (90, 160)


def test_generation_prompt_and_requested_dimensions_survive_job_memory_loss(library, monkeypatch):
    class ImmediateThread:
        def __init__(self, *, target, **_):
            self.target = target

        def start(self):
            self.target()

    def generate(cmd, **_):
        output = Path(cmd[cmd.index('--output') + 1])
        for index in (1, 2):
            save_image(output.with_name(f'{output.stem}-{index}.webp'), (160, 90))
        return SimpleNamespace(returncode=0, stdout='', stderr='')

    monkeypatch.setattr(web.threading, 'Thread', ImmediateThread)
    monkeypatch.setattr(web.subprocess, 'run', generate)
    monkeypatch.setattr(web, 'child_env', lambda *_: {})
    prompt = '保留完整提示词。' * 30
    started = asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt=prompt, size='864x1536', n=2)))
    assert web._IMAGEGEN_JOBS[started['jobId']]['state'] == 'done'
    web._IMAGEGEN_JOBS.clear()
    files = flatten(web.api_outputs())
    assert len(files) == 2  # Hidden metadata must not appear as separate content files.
    for file in files:
        assert file['generation']['prompt'] == prompt
        assert file['generation']['size'] == '864x1536'
        assert file['generation']['model'] == 'test-image'
        assert file['generation']['jobId'] == started['jobId']
        assert (file['width'], file['height']) == (160, 90)
        assert 'secret-test-value' not in json.dumps(file)


@pytest.mark.parametrize('metadata', ['broken json', '[]', '{"prompt": 123}', '{"prompt": "valid", "model": {"private": true}}'])
def test_bad_metadata_cannot_hide_or_break_an_existing_image(library, metadata):
    path = save_image(web.IMAGEGEN_DIR / 'existing.png')
    web._imagegen_metadata_path(path).write_text(metadata, encoding='utf-8')
    files = flatten(web.api_outputs())
    assert len(files) == 1 and files[0]['name'] == path.name
    assert 'model' not in files[0].get('generation', {})


def test_delete_image_cleans_up_its_metadata_only(library):
    path = save_image(web.IMAGEGEN_DIR / 'remove.png')
    keep = save_image(web.IMAGEGEN_DIR / 'keep.png')
    sidecar = web._imagegen_metadata_path(path)
    sidecar.write_text('{"prompt":"test"}', encoding='utf-8')
    result = asyncio.run(web.api_output_delete('AI生图/remove.png'))
    assert result['ok'] is True
    assert not path.exists() and not sidecar.exists()
    assert keep.exists()


def test_image_media_serves_the_unchanged_original(library):
    path = save_image(library / 'images' / 'portrait.png')
    before = path.read_bytes()
    response = asyncio.run(web.api_media('images/portrait.png'))
    assert Path(response.path) == path
    assert path.read_bytes() == before

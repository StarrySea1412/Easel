"""Real temporary files and API reads; no provider requests or generation."""
import json
from pathlib import Path
from io import BytesIO
from PIL import Image
import subprocess
import os
import sys

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from easel.artifacts import ArtifactStore
from easel.artifact_api import router


def png(color):
    out = BytesIO(); Image.new('RGB', (8, 8), color).save(out, format='PNG', compress_level=0)
    return out.getvalue()


@pytest.fixture
def delivery(tmp_path):
    root = tmp_path / 'outputs'; topic = root / '真实主题'; topic.mkdir(parents=True)
    (topic / 'a.png').write_bytes(png('red'))
    (topic / 'page.html').write_text('<html><head><link href="style.css" rel="stylesheet"></head><body><img src="a.png"><script>document.body.dataset.ready="yes"</script></body></html>', encoding='utf-8')
    (topic / 'style.css').write_text('body{background:#fff;background-image:url(a.png)}', encoding='utf-8')
    store = ArtifactStore(root)
    ticket = store.bind('chat1', 'turn1')
    values = store.present_ticket(ticket, [{'path': '真实主题/a.png'}, {'path': '真实主题/page.html'}])
    app = FastAPI(); app.include_router(router(lambda: root))
    return root, topic, store, ticket, values, TestClient(app)


def test_delivery_survives_new_store_without_final_message_and_is_idempotent(delivery):
    root, _, store, ticket, values, client = delivery
    assert store.bind('chat1', 'turn1') == ticket
    before = store.snapshot('chat1')
    assert len(before['events']) == 2
    store.present_ticket(ticket, [{'path': '真实主题/a.png'}, {'path': '真实主题/page.html'}])
    restored = ArtifactStore(root).snapshot('chat1')
    assert restored == before
    assert len(restored['artifacts']) == 2
    assert all(a['turnId'] == 'turn1' for a in restored['artifacts'])
    assert client.get('/api/chat/artifacts/chat2').json()['artifacts'] == []
    assert client.get(f'/api/chat/artifacts/chat2/{values[0]["id"]}/file').status_code == 404
    assert store.snapshot('chat1', after=before['cursor'])['events'] == []
    with pytest.raises(ValueError):
        store.present_ticket('invalid', [{'path': '真实主题/a.png'}])


def test_same_size_same_mtime_overwrite_and_html_dependency_refresh(delivery):
    _, topic, store, _, values, client = delivery
    image, html = values
    path = topic / 'a.png'; stamp = path.stat().st_mtime_ns
    path.write_bytes(png('blue'))
    os.utime(path, ns=(stamp, stamp))
    refreshed = client.post(f'/api/chat/artifacts/chat1/{image["id"]}/refresh').json()
    assert refreshed['id'] == image['id'] and refreshed['version'] != image['version']
    changed_html = store.refresh('chat1', html['id'])
    assert changed_html['version'] != html['version']
    preview = client.get(f'/api/chat/artifacts/chat1/{html["id"]}/preview')
    assert preview.status_code == 200
    assert f'/resource/{changed_html["version"]}/' in preview.text
    assert 'sandbox allow-scripts' in preview.headers['content-security-policy']
    assert 'allow-same-origin' not in preview.headers['content-security-policy']
    prefix = f'/api/chat/artifacts/chat1/{html["id"]}/resource/{changed_html["version"]}/真实主题/'
    css = client.get(prefix + 'style.css')
    assert css.status_code == 200 and f'/resource/{changed_html["version"]}/' in css.text
    assert client.get(prefix + 'a.png').content == png('blue')
    assert client.get(prefix + 'not-declared.png').status_code == 404
    assert client.get(prefix.replace(changed_html['version'], html['version']) + 'a.png').status_code == 404


def test_missing_file_recovers_and_downloads_are_non_executable(delivery):
    _, topic, store, _, values, client = delivery
    image, html = values
    (topic / 'a.png').unlink()
    assert store.refresh('chat1', image['id'])['status'] == 'missing'
    assert client.get(f'/api/chat/artifacts/chat1/{image["id"]}/file').status_code == 404
    (topic / 'a.png').write_bytes(png('green'))
    assert store.refresh('chat1', image['id'])['status'] == 'ready'
    raw = client.get(f'/api/chat/artifacts/chat1/{html["id"]}/file')
    assert 'attachment;' in raw.headers['content-disposition']
    assert raw.headers['cache-control'] == 'no-store'


def test_batch_invalid_paths_do_not_partially_deliver(delivery, tmp_path):
    root, topic, store, _, _, _ = delivery
    ticket = store.bind('other', 'turn2')
    (root / '_private').mkdir(); (root / '_private/x.txt').write_text('secret')
    for path in ('../outside', '_private/x.txt', '真实主题/../a.txt', '真实主题/missing.txt'):
        with pytest.raises((ValueError, OSError)):
            store.present_ticket(ticket, [{'path': '真实主题/a.png'}, {'path': path}])
    assert store.snapshot('other')['artifacts'] == []
    outside = tmp_path / 'private.txt'; outside.write_text('private')
    try:
        (topic / 'escape.txt').symlink_to(outside)
    except OSError:
        return  # Windows hosts without symlink privilege still check traversal above.
    with pytest.raises(ValueError):
        store.present_ticket(ticket, [{'path': '真实主题/escape.txt'}])


def test_present_command_writes_exact_turn_without_network(delivery):
    root, _, store, ticket, _, _ = delivery
    script = Path(__file__).resolve().parents[1] / 'skills/shared/scripts/present_artifact.py'
    result = subprocess.run([sys.executable, str(script), '--ticket', ticket, '--file', str(root / '真实主题/a.png')],
                            env={**os.environ, 'EASEL_DATA_DIR': str(root.parent), 'PYTHONIOENCODING': 'utf-8'}, capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)['ok']
    assert len(store.snapshot('chat1')['artifacts']) == 2


def test_codex_host_executes_registered_present_tool_with_exact_scope(delivery):
    root, _, store, _, _, _ = delivery
    from easel.codex_service import CodexService
    workspace = root / 'codex' / 'owned'; workspace.mkdir(parents=True)
    (workspace / 'output.html').write_text('<h1>真实页面</h1>', encoding='utf-8')
    service = CodexService(root)
    state = {'workspace': str(workspace), 'sessionId': 'codex1', 'turn_id': 'ct1', 'seq': 0}
    events = []; service._event = lambda state, kind, data: events.append((kind, data))
    class Client:
        def reply(self, ident, value): self.value = value
    client = Client(); run = {'state': state, 'client': client}
    event = {'id': 3, 'method': 'item/tool/call', 'params': {'tool': 'easel_present', 'callId': 'tool1', 'arguments': {'files': [{'path': 'output.html'}]}}}
    service._request(run, event)
    assert client.value['success']
    assert store.snapshot('codex1')['artifacts'][0]['toolCallId'] == 'tool1'
    event['params']['arguments']['files'][0]['path'] = '../../真实主题/a.png'
    service._request(run, event)
    assert not client.value['success']


def test_openclaw_tool_factory_executes_present_and_rejects_foreign_ticket(delivery):
    root, _, store, ticket, _, _ = delivery
    import shutil
    node = shutil.which('node')
    if not node:
        pytest.skip('Node runtime unavailable')
    module = Path(__file__).resolve().parents[1] / 'openclaw/easel-agent-safety/present.mjs'
    program = '''import {registerPresent} from MODULE;
let factory; registerPresent({registerTool:(value)=>{factory=value}});
const tool=factory({sessionKey:'agent:main:chat1'});
const response=await tool.execute('native-call',{ticket:TICKET,files:[FILE]});
if(!response.details.ok) throw new Error('No real delivery');
let rejected=false;try {await factory({sessionKey:'agent:main:other'}).execute('foreign',{ticket:TICKET,files:[FILE]})}catch{rejected=true}
if(!rejected)throw new Error('Cross-session ticket accepted');
console.log(JSON.stringify({ok:true,name:tool.name}));'''.replace('MODULE', json.dumps(module.as_uri())).replace('TICKET', json.dumps(ticket)).replace('FILE', json.dumps(str(root/'真实主题/a.png')))
    result = subprocess.run([node, '--input-type=module'], input=program, capture_output=True, text=True, encoding='utf-8',
                            env={**os.environ, 'EASEL_DATA_DIR': str(root.parent), 'EASEL_PYTHON': sys.executable}, timeout=35)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)['ok']
    # Existing delivery is idempotent; it does not create another event or job.
    assert len(store.snapshot('chat1')['events']) == 2


def test_corrupt_image_is_not_presented_as_a_success(delivery):
    root, topic, store, ticket, _, _ = delivery
    (topic / 'bad.png').write_bytes(b'not-a-real-image')
    with pytest.raises(OSError):
        store.present_ticket(ticket, [{'path': '真实主题/bad.png'}])
    assert len(store.snapshot('chat1')['artifacts']) == 2


def test_internal_registry_cannot_escape_through_legacy_file_apis(delivery, monkeypatch):
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
    import app as web
    root, _, _, _, _, _ = delivery
    monkeypatch.setattr(web, 'OUTPUTS_DIR', root)
    for resolve in (web._safe_output_path, web._safe_output_target):
        with pytest.raises(web.HTTPException) as exc:
            resolve('_artifacts/registry.sqlite3')
        assert exc.value.status_code == 403
    with pytest.raises(ValueError):
        web.ChatRequest(message='test', sessionId='../escape')

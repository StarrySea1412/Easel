"""Versioned analysis/writing/image flow with synthetic sources and provider."""
import json
import asyncio
from pathlib import Path
from types import SimpleNamespace

from PIL import Image
import pytest

from easel.image_jobs import ImageJobs, ImageWorker
from easel.creation_drafts import CreationDrafts
from easel.task_store import TaskStore
from easel.writing_handoffs import WritingHandoffs
from tests.test_writing_handoffs import seeded, prepare


CONFIG = {'IMG_BASE_URL': 'https://fixture.invalid/v1', 'IMG_MODEL': 'fixture-image',
          'IMG_API_KEY': 'synthetic-only'}


def flow(root):
    writing, materials, conversations, binding, result = seeded(root)
    handoff = prepare(writing, binding)
    return writing, materials, conversations, binding, result, handoff


def submit(root, handoff, request='cover'):
    return ImageJobs(root).submit({'prompt': '为明确请求的合成教程生成封面'}, CONFIG,
        session=handoff['sessionId'], turn='writing-turn', request_id=request)


def change(root, source, kind):
    writing, materials, conversations, binding, result, handoff = source
    if kind == 'result':
        conversations.save_result(binding['id'], {**result, 'turnId': 'updated-analysis-turn',
            'markdown': '## 新的合成结论\n作品sample的新版本已变化，原封面请求须重新确认。'})
    elif kind == 'materials':
        materials.ingest({'platform': 'zhihu', 'accountId': 'isolated-owner',
            'contents': [{'id': 'sample', 'title': '全新的合成材料', 'body': '原来源版本已经改变。'}]})
    else:
        TaskStore(root).delete_session('analysis-chat')


@pytest.mark.parametrize('kind', ['result', 'materials', 'deleted'])
@pytest.mark.parametrize('claimed', [False, True])
def test_stale_writing_source_never_reaches_image_provider(tmp_path, kind, claimed):
    source = flow(tmp_path)
    handoff = source[-1]
    job = submit(tmp_path, handoff)
    jobs = ImageJobs(tmp_path)
    calls = []
    def provider(cmd, **options):
        calls.append(cmd)
        Image.new('RGB', (12, 16)).save(cmd[cmd.index('--output') + 1])
        return SimpleNamespace(returncode=0)
    worker = ImageWorker(Path(__file__).resolve().parents[1], lambda: tmp_path,
                         lambda: CONFIG, lambda: {}, runner=provider)
    current = jobs.claim(CONFIG, worker.owner) if claimed else None
    change(tmp_path, source, kind)
    if not claimed:
        current = ImageJobs(tmp_path).claim(CONFIG, worker.owner)
    if current:
        worker.run(jobs, current, CONFIG)
    assert calls == []
    saved = jobs.get(job['jobId'])
    assert saved['phase'] == 'error'
    assert '来源' in saved['error'] and '未提交' in saved['error']
    assert not jobs.pending(handoff['sessionId'], 'writing-turn')
    assert not (tmp_path / '_artifacts/image-receipts').exists()


def test_new_image_rejects_stale_source_without_creating_job(tmp_path):
    source = flow(tmp_path)
    change(tmp_path, source, 'result')
    with pytest.raises(ValueError, match='分析|来源'):
        submit(tmp_path, source[-1])
    assert ImageJobs(tmp_path).list(source[-1]['sessionId']) == []


def test_writing_image_keeps_original_source_in_job_and_file_metadata(tmp_path):
    source = flow(tmp_path)
    handoff = source[-1]
    job = submit(tmp_path, handoff)
    origin = job['creationSource']
    assert origin['schemaVersion'] == 1 and origin['writingHandoffId'] == handoff['id']
    assert origin['sourceHash'] == handoff['sourceHash']
    assert origin['sourceTurnId'] == 'analysis-turn'
    assert 'markdown' not in json.dumps(origin)
    calls = []
    def provider(cmd, **options):
        calls.append(cmd)
        change(tmp_path, source, 'result')  # An already dispatched request remains real work.
        Image.new('RGB', (12, 16)).save(cmd[cmd.index('--output') + 1])
        return SimpleNamespace(returncode=0)
    jobs = ImageJobs(tmp_path)
    worker = ImageWorker(Path(__file__).resolve().parents[1], lambda: tmp_path,
                         lambda: CONFIG, lambda: {}, runner=provider)
    current = jobs.claim(CONFIG, worker.owner)
    worker.run(jobs, current, CONFIG)
    saved = ImageJobs(tmp_path).get(job['jobId'])
    assert saved['phase'] == 'done' and saved['creationSource'] == origin and len(calls) == 1
    image = tmp_path / saved['paths'][0]
    metadata = json.loads(image.with_name('.' + image.name + '.easel-image.json').read_text(encoding='utf-8'))
    assert metadata['creationSource'] == origin
    assert submit(tmp_path, handoff)['jobId'] == job['jobId']


def generated(root):
    source = flow(root)
    job = submit(root, source[-1])
    def provider(cmd, **options):
        Image.new('RGB', (12, 16)).save(cmd[cmd.index('--output') + 1])
        return SimpleNamespace(returncode=0)
    jobs = ImageJobs(root)
    worker = ImageWorker(Path(__file__).resolve().parents[1], lambda: root,
                         lambda: CONFIG, lambda: {}, runner=provider)
    worker.run(jobs, jobs.claim(CONFIG, worker.owner), CONFIG)
    return source, jobs.get(job['jobId'])


def test_generated_source_survives_draft_confirmation_and_restart(tmp_path):
    source, job = generated(tmp_path)
    handoff = source[-1]
    drafts = CreationDrafts(tmp_path)
    item = drafts.prepare(handoff['sessionId'], 'writing-turn', {'requestId': 'draft',
        'body': '隔离合成正文，不执行发布', 'media': job['paths']})
    origin = job['creationSource']
    assert item['analysis']['writingHandoffId'] == origin['writingHandoffId']
    assert item['mediaVersions'][0]['creationSource'] == origin
    payload = {key: item['draft'][key] for key in ('title', 'body', 'tags', 'media')}
    payload['persona'] = ''
    accepted = drafts.accept(handoff['sessionId'], item['id'], 'confirm', 'zhihu', payload)
    proof, copies = CreationDrafts(tmp_path).verify_acceptance(
        handoff['sessionId'], accepted['id'], 'zhihu', payload)
    assert proof['mediaVersions'][0]['creationSource'] == origin
    assert copies[0].read_bytes() == (tmp_path / job['paths'][0]).read_bytes()
    assert ImageJobs(tmp_path).get(job['jobId'])['creationSource'] == origin


@pytest.mark.parametrize('tamper', ['image', 'sidecar', 'job-id'])
def test_media_origin_uses_saved_job_and_exact_bytes_not_sidecar_claims(tmp_path, tamper):
    source, job = generated(tmp_path)
    path = tmp_path / job['paths'][0]
    sidecar = path.with_name('.' + path.name + '.easel-image.json')
    if tamper == 'image':
        Image.new('RGB', (12, 16), 'red').save(path)
    else:
        metadata = json.loads(sidecar.read_text(encoding='utf-8'))
        metadata['creationSource'] = {'writingHandoffId': 'forged'}
        if tamper == 'job-id':
            metadata['jobId'] = 'nonexistent-job'
        sidecar.write_text(json.dumps(metadata), encoding='utf-8')
    versions = CreationDrafts(tmp_path).media_versions(job['paths'])
    if tamper == 'sidecar':
        assert versions[0]['creationSource'] == job['creationSource']
    else:
        assert 'creationSource' not in versions[0]


def test_original_receipt_is_readable_after_source_and_credentials_change(tmp_path):
    source = flow(tmp_path)
    handoff = source[-1]
    original = submit(tmp_path, handoff)
    change(tmp_path, source, 'result')
    receipt = ImageJobs(tmp_path).submit({'prompt': '为明确请求的合成教程生成封面'},
        {**CONFIG, 'IMG_API_KEY': ''}, session=handoff['sessionId'],
        turn='writing-turn', request_id='cover')
    assert receipt == original
    assert ImageJobs(tmp_path).claim(CONFIG, 'restarted-owner') is None
    assert ImageJobs(tmp_path).get(original['jobId'])['creationSource'] == original['creationSource']


@pytest.mark.parametrize('tamper', ['missing', 'extra-field', 'wrong-id', 'bool-schema'])
def test_queued_source_proof_is_not_silently_rebound(tmp_path, tamper):
    source = flow(tmp_path)
    job = submit(tmp_path, source[-1])
    jobs = ImageJobs(tmp_path)
    with jobs.db() as db:
        row = db.execute('SELECT data FROM jobs WHERE id=?', (job['jobId'],)).fetchone()
        data = json.loads(row['data'])
        if tamper == 'missing':
            data.pop('creationSource')
        elif tamper == 'extra-field':
            data['creationSource']['extra'] = 'untrusted'
        elif tamper == 'wrong-id':
            data['creationSource']['writingHandoffId'] = 'different'
        else:
            data['creationSource']['schemaVersion'] = True
        db.execute('UPDATE jobs SET data=? WHERE id=?', (json.dumps(data), job['jobId']))
    assert ImageJobs(tmp_path).claim(CONFIG, 'restarted-owner') is None
    saved = jobs.get(job['jobId'])
    assert saved['phase'] == 'error' and '来源' in saved['error']


def test_session_studio_api_owns_an_independent_idempotent_source_bound_job(tmp_path, monkeypatch):
    import app as web
    source = flow(tmp_path)
    handoff = source[-1]
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path)
    monkeypatch.setattr(web, '_read_env', lambda: CONFIG)
    ticks = []
    monkeypatch.setattr(web, '_image_worker', lambda: SimpleNamespace(tick=lambda: ticks.append(True)))
    request = web.ImagegenRequest(prompt='独立手动工坊封面', sessionId=handoff['sessionId'], requestId='studio-cover')
    job = asyncio.run(web.api_imagegen_start(request))
    assert job['sessionId'] == handoff['sessionId']
    assert job['turnId'].startswith('studio-') and job['turnId'] != 'writing-turn'
    assert job['creationSource']['writingHandoffId'] == handoff['id']
    ImageJobs(tmp_path).cancel_turn(handoff['sessionId'], 'writing-turn')
    assert ImageJobs(tmp_path).get(job['jobId'])['phase'] == 'queued'
    change(tmp_path, source, 'result')
    assert asyncio.run(web.api_imagegen_start(request))['jobId'] == job['jobId']
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_imagegen_start(request.model_copy(update={'requestId': 'new-cover'})))
    assert failure.value.status_code == 400 and len(ticks) == 2
    assert len(ImageJobs(tmp_path).list(handoff['sessionId'])) == 1


def test_manual_studio_image_preserves_source_without_faking_assistant_delivery(tmp_path):
    from easel.artifacts import ArtifactStore
    source = flow(tmp_path)
    session = source[-1]['sessionId']
    jobs = ImageJobs(tmp_path)
    job = jobs.submit({'prompt': '手动工坊合成封面'}, CONFIG, session=session,
        turn='studio-' + 'a' * 40, request_id='manual-studio')
    def provider(cmd, **options):
        Image.new('RGB', (12, 16)).save(cmd[cmd.index('--output') + 1])
        return SimpleNamespace(returncode=0)
    worker = ImageWorker(Path(__file__).resolve().parents[1], lambda: tmp_path,
        lambda: CONFIG, lambda: {}, runner=provider)
    worker.run(jobs, jobs.claim(CONFIG, worker.owner), CONFIG)
    saved = jobs.get(job['jobId'])
    assert saved['phase'] == 'done' and saved['creationSource'] == job['creationSource']
    assert (tmp_path / saved['paths'][0]).is_file()
    assert not saved.get('artifactIds')
    assert ArtifactStore(tmp_path).snapshot(session)['artifacts'] == []


def test_session_studio_without_fixed_request_does_not_submit(tmp_path, monkeypatch):
    import app as web
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path)
    monkeypatch.setattr(web, '_read_env', lambda: CONFIG)
    with pytest.raises(web.HTTPException) as failure:
        asyncio.run(web.api_imagegen_start(web.ImagegenRequest(prompt='合成封面', sessionId='write-scoped')))
    assert failure.value.status_code == 400
    assert not (tmp_path / '_artifacts/image-jobs.sqlite3').exists()

"""Offline moderation follow-up: no platform login, publishing or SMTP traffic."""
from __future__ import annotations

import importlib.util
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import pytest

from easel import publish_followup as followup, publish_receipts

ROOT = Path(__file__).resolve().parents[1]
_fixture_spec = importlib.util.spec_from_file_location(
    '_easel_publish_api_fixture', ROOT / 'tests/test_publish_receipts.py')
_fixture_module = importlib.util.module_from_spec(_fixture_spec)
_fixture_spec.loader.exec_module(_fixture_module)
api, emitted = _fixture_module.api, _fixture_module.emitted

RID = 'a' * 32
CID = '0123456789abcdef01234567'
URL = 'https://www.xiaohongshu.com/explore/' + CID


def checked(outcome='published', *, content_id=CID, status=None, matched=True):
    return {'outcome': outcome, 'state': 'finished', 'pending': False,
            'ok': outcome == 'published', 'contentId': content_id,
            'url': URL if outcome == 'published' else '', 'platformStatus': status or outcome,
            'message': '隔离平台核实结果',
            'evidence': {'matched': matched, 'readbackOutcome': 'verified' if matched else 'readback_error',
                         'kind': 'creator_readback', 'publicAccessChecked': False}}


@pytest.fixture
def harness(tmp_path):
    store = publish_receipts.ReceiptStore(tmp_path / 'receipts.json')
    store.create(RID, 'xiaohongshu', '本次作品')
    clock = [time.time()]
    row = store.update(RID, {'outcome': 'submitted', 'state': 'finished', 'pending': False,
                            'contentId': CID, 'platformStatus': 'reviewing'})
    store.update(RID, {'verification': followup.initial_verification(row, now=clock[0])})
    active, calls, effects = {}, [], []
    def acquire(platform, rid):
        if platform in active:
            return False
        active[platform] = rid
        return True
    def release(platform, rid):
        assert active.pop(platform) == rid
    def run(row, stop):
        calls.append(row)
        return checked()
    def complete(row):
        effects.append(row)
        store.update(row['receiptId'], {'completionHandled': True, 'completionPending': False})
    service = followup.VerificationService(
        list_items=store.awaiting_verification, get_item=store.get, save_item=store.update,
        acquire=acquire, release=release, run_check=run, on_confirmed=complete,
        now=lambda: clock[0])
    return SimpleNamespace(store=store, clock=clock, active=active, calls=calls, effects=effects,
                           service=service, row=lambda: store.get(RID))


def test_pending_waits_before_check_then_publishes_once(harness):
    h = harness
    assert h.service.tick() is False and not h.calls
    h.clock[0] += 61
    assert h.service.tick() is True
    assert h.row()['outcome'] == 'published' and h.row()['url'] == URL
    assert h.row()['verification']['state'] == 'complete'
    assert len(h.calls) == len(h.effects) == 1 and not h.active
    h.clock[0] += 300
    assert h.service.tick() is False
    with pytest.raises(followup.VerificationError):
        h.service.request(RID)
    assert len(h.effects) == 1


@pytest.mark.parametrize('bad', ['different-id', 'missing-id', 'not-matched', 'raised', 'bare-success'])
def test_uncertain_readback_preserves_previous_submission_and_retries(harness, bad):
    h = harness
    def run(*_):
        if bad == 'raised':
            raise RuntimeError('PRIVATE_NETWORK_DETAIL')
        if bad == 'bare-success':
            return {'outcome': 'published', 'url': URL, 'contentId': CID}
        return checked(content_id='other' if bad == 'different-id' else '' if bad == 'missing-id' else CID,
                       matched=bad != 'not-matched')
    h.service.run_check = run
    h.service.request(RID)
    assert h.service.tick()
    row = h.row()
    assert row['outcome'] == 'submitted' and row['contentId'] == CID and not row['url']
    assert row['verification']['state'] == 'waiting' and not h.effects
    assert followup.timestamp(row['verification']['nextCheckAt']) > h.clock[0]
    assert 'PRIVATE_NETWORK_DETAIL' not in json.dumps(row)


def test_followup_uses_increasing_intervals_and_a_finite_attempt_budget(harness):
    h = harness
    h.service.run_check = lambda *_: checked('submitted', status='reviewing')
    previous_delay = 0
    for count in range(1, followup.MAX_ATTEMPTS + 1):
        h.clock[0] = followup.timestamp(h.row()['verification']['nextCheckAt']) + 0.01
        assert h.service.tick()
        state = h.row()['verification']
        assert state['attempts'] == count
        if count < followup.MAX_ATTEMPTS:
            delay = followup.timestamp(state['nextCheckAt']) - h.clock[0]
            assert delay >= previous_delay - 0.01
            previous_delay = delay
        else:
            assert state['state'] == 'exhausted' and state['nextCheckAt'] is None
    assert h.row()['outcome'] == 'submitted' and not h.effects


@pytest.mark.parametrize('preview_id', [CID, '../secret', None])
def test_unmatched_xhs_preview_survives_worker_without_claiming_identity(harness, preview_id):
    h = harness
    h.store.update(RID, {'contentId': '', 'outcome': 'unverified',
                         'submissionFinishedAt': followup.iso(h.clock[0]),
                         'evidence': {'sinceMs': int(h.clock[0] * 1000) - 100,
                                      'previewContentId': 'b' * 24}})
    raw = {'schemaVersion': 1, 'receiptId': RID, 'platform': 'xiaohongshu',
        'outcome': 'unverified', 'contentId': '', 'url': '',
        'evidence': {'matched': False, 'source': 'xhs_creator_notes', 'readOnly': True,
                     'readbackOutcome': 'unverified', 'previewContentId': preview_id,
                     'rawToken': 'never-save-this'}}
    h.service.run_check = lambda *_: publish_receipts.parse_result('xiaohongshu', RID,
        publish_receipts.MARKER + json.dumps(raw), 5)
    h.service.request(RID)
    assert h.service.tick()
    row = h.row()
    assert row['outcome'] == 'unverified' and not row['contentId'] and not row['url']
    assert row['evidence'].get('previewContentId') == (CID if preview_id == CID else None)
    assert 'sinceMs' in row['evidence'] and 'rawToken' not in row['evidence']
    assert not h.effects


@pytest.mark.parametrize('has_id', [False, True])
def test_old_scheduled_records_expire_without_any_platform_request(harness, has_id):
    h = harness
    if not has_id:
        h.store.update(RID, {'contentId': ''})
    h.clock[0] += followup.MAX_AGE_SECONDS + 60
    assert not h.service.tick()
    assert h.row()['verification']['state'] == 'exhausted' and not h.calls
    if has_id:
        h.service.request(RID)
        assert h.service.tick() and h.row()['outcome'] == 'published'
    else:
        with pytest.raises(followup.VerificationError):
            h.service.request(RID)


def test_pause_resume_manual_check_and_cooldown(harness):
    h = harness
    h.service.run_check = lambda *_: checked('submitted', status='reviewing')
    h.service.request(RID, automatic=False)
    h.clock[0] += 100
    assert not h.service.tick()
    h.service.request(RID)
    assert h.service.tick()
    assert h.row()['verification']['state'] == 'paused'
    with pytest.raises(followup.VerificationError) as error:
        h.service.request(RID)
    assert error.value.status_code == 429
    h.clock[0] += followup.MANUAL_COOLDOWN_SECONDS + 1
    h.service.request(RID, automatic=True)
    assert h.service.tick() and h.row()['verification']['state'] == 'waiting'


@pytest.mark.parametrize('kind,state', [('private', 'paused'), ('login', 'login_required'), ('rejected', 'complete')])
def test_restricted_login_expired_and_rejected_results_stop_automatic_checks(harness, kind, state):
    h = harness
    result = checked('failed' if kind == 'rejected' else 'unverified', status=kind)
    if kind == 'login':
        result['evidence'] = {'readbackOutcome': 'login_required'}
    h.service.run_check = lambda *_: result
    h.service.request(RID)
    h.service.tick()
    assert h.row()['verification']['state'] == state
    assert h.row()['verification']['automatic'] is False
    assert not h.effects and not h.active


def test_pause_during_check_survives_completion(harness):
    h = harness
    def run(*_):
        h.service.request(RID, automatic=False)
        return checked('submitted', status='reviewing')
    h.service.run_check = run
    h.service.request(RID)
    h.service.tick()
    assert h.row()['verification']['state'] == 'paused'


def test_same_platform_publication_reservation_blocks_verification(harness):
    h = harness
    h.active['xiaohongshu'] = 'b' * 32
    h.service.request(RID)
    assert not h.service.tick() and not h.calls
    assert h.active == {'xiaohongshu': 'b' * 32}
    h.active.clear()
    assert h.service.tick()


def test_repeated_requests_while_checking_do_not_launch_a_second_reader(harness):
    h = harness
    def run(*_):
        h.calls.append(True)
        assert h.service.request(RID)['verification']['state'] == 'checking'
        assert not h.service.tick()
        return checked()
    h.service.run_check = run
    h.service.request(RID)
    assert h.service.tick() and len(h.calls) == 1


def test_failed_durable_reservation_does_not_contact_platform(harness):
    h = harness
    h.service.request(RID)
    h.service.save_item = lambda _rid, change: {**h.row(), **change, 'storageWarning': 'disk failed'}
    assert not h.service.tick() and not h.calls and not h.active


def test_two_receipts_cannot_claim_the_same_public_work(harness):
    h = harness
    other = 'b' * 32
    h.store.create(other, 'xiaohongshu', '重复标题')
    h.store.update(other, {'outcome': 'submitted'})
    barrier = threading.Barrier(2)
    def publish(rid):
        barrier.wait(timeout=5)
        return h.store.update(rid, checked())
    with ThreadPoolExecutor(max_workers=2) as pool:
        values = list(pool.map(publish, [RID, other]))
    assert sum(row['outcome'] == 'published' for row in values) == 1
    duplicate = next(row for row in values if row['outcome'] != 'published')
    assert duplicate['verification']['state'] == 'paused' and not duplicate['url']
    assert duplicate['notification']['state'] == 'skipped'


def test_later_title_match_cannot_steal_an_id_already_returned_to_another_submission(harness):
    h = harness
    h.store.update(RID, {'contentId': ''})
    other = 'b' * 32
    h.store.create(other, 'xiaohongshu', '重复标题')
    h.store.update(other, {'outcome': 'submitted', 'contentId': CID})
    claimed = h.store.update(RID, checked())
    assert claimed['outcome'] == 'unverified'
    assert h.store.update(other, checked())['outcome'] == 'published'


@pytest.mark.parametrize('automatic', [True, False])
def test_restart_recovers_checking_state_without_resubmission(harness, automatic):
    h = harness
    h.store.update(RID, {'verification': {'state': 'checking', 'automatic': automatic,
                                          'attempts': 2, 'nextCheckAt': None}})
    h.store.recover_interrupted()
    state = h.row()['verification']
    assert state['state'] == ('waiting' if automatic else 'paused')
    assert state['attempts'] == 2 and h.row()['outcome'] == 'submitted'
    assert not h.calls


def test_stopped_service_does_not_launch_a_reader(harness):
    harness.service.request(RID)
    harness.service.stop()
    assert not harness.service.tick() and not harness.calls


def test_restart_finishes_unclaimed_publication_effects_without_checking_or_uploading(harness):
    h = harness
    h.store.update(RID, {**checked(), 'completionPending': True})
    h.store.recover_interrupted()
    assert h.service.tick() and len(h.effects) == 1 and not h.calls
    assert not h.service.tick() and len(h.effects) == 1


def test_old_published_history_does_not_start_notifications_after_upgrade(harness):
    h = harness
    h.store.update(RID, {**checked(), 'notification': {'state': 'skipped'}})
    assert not h.service.tick() and not h.effects


def test_restart_reports_uncertain_claimed_notification_without_resending(harness):
    h = harness
    h.store.update(RID, {**checked(), 'completionPending': False, 'completionHandled': True,
                        'notification': {'state': 'queued', 'message': 'starting'}})
    h.store.recover_interrupted()
    assert h.row()['notification']['state'] == 'failed'
    assert not h.service.tick() and not h.effects


@pytest.mark.parametrize('platform', sorted(followup.PLATFORMS))
def test_command_routes_only_to_explicit_read_only_entry_points(harness, platform):
    row = {**harness.row(), 'platform': platform}
    command = followup.verification_command(row, python=sys.executable, root=ROOT, data_dir=ROOT / 'data')
    assert '--exec' not in command and 'publish' not in command and 'upload' not in command
    assert '--since-ms' in command and '--content-id' in command
    assert command[:3] == [sys.executable, '-X', 'utf8']
    assert any('verify' in value for value in command)


def test_exact_submit_timestamp_is_kept_in_subsequent_commands(harness):
    row = harness.row()
    since = int(followup.timestamp(row['createdAt']) * 1000) + 500
    row['evidence'] = {'sinceMs': since}
    command = followup.verification_command(row, python=sys.executable, root=ROOT, data_dir=ROOT)
    assert int(command[command.index('--since-ms') + 1]) == since
    row['evidence']['sinceMs'] = -1
    command = followup.verification_command(row, python=sys.executable, root=ROOT, data_dir=ROOT)
    assert int(command[command.index('--since-ms') + 1]) > 0


def test_no_id_requires_the_original_closed_submission_window(harness):
    row = {**harness.row(), 'contentId': ''}
    assert followup.initial_verification(row)['state'] == 'unsupported'
    with pytest.raises(ValueError):
        followup.verification_command(row, python=sys.executable, root=ROOT, data_dir=ROOT)
    row['submissionFinishedAt'] = followup.iso(time.time() + 1)
    command = followup.verification_command(row, python=sys.executable, root=ROOT, data_dir=ROOT)
    assert int(command[command.index('--until-ms') + 1]) == int(followup.timestamp(row['submissionFinishedAt']) * 1000)


def test_pending_checks_are_not_lost_outside_the_recent_history_window(harness):
    h = harness
    for index in range(205):
        rid = f'{index + 100:032x}'
        h.store.create(rid, 'zhihu', f'finished {index}')
        h.store.update(rid, {'outcome': 'published', 'state': 'finished'})
    assert RID not in {row['receiptId'] for row in h.store.recent()}
    h.service.request(RID)
    assert h.service.tick() and h.row()['outcome'] == 'published'


def test_managed_reader_runs_a_real_local_process_without_a_visible_console(tmp_path):
    result = followup.run_process([sys.executable, '-c', 'print("local reader check")'],
                                 cwd=tmp_path, env=dict(__import__('os').environ),
                                 stop_event=threading.Event(), timeout=10)
    assert result.returncode == 0 and result.stdout.strip() == 'local reader check'


def test_api_moderation_transition_updates_calendar_and_notifies_exactly_once(api):
    client, namespace, calls, _ = api
    def initial(cmd, **kwargs):
        calls.append(cmd)
        return SimpleNamespace(returncode=0, stderr='', stdout=emitted(
            'xiaohongshu', kwargs['env']['EASEL_PUBLISH_RECEIPT_ID'], 'submitted',
            contentId=CID, url='', platformStatus='reviewing'))
    namespace['subprocess'].run = initial
    mail = []
    namespace['_notify_email_completion'] = lambda **kwargs: mail.append(kwargs) or {'state': 'sent'}
    row = client.post('/api/publish/xiaohongshu', json={'title': '核实验收', 'body': '概要', 'media': ['image.png']}).json()
    rid = row['receiptId']
    assert row['outcome'] == 'submitted' and not mail
    assert client.get('/api/publish/receipts').json()[0]['receiptId'] == rid
    assert len(calls) == 1
    service = namespace['_publish_verification_service']()
    checks = []
    service.run_check = lambda receipt, _stop: checks.append(receipt['receiptId']) or checked()
    assert client.post(f'/api/publish/receipts/{rid}/verify').status_code == 200
    assert len(calls) == 1 and not mail and service.tick()
    result = client.get(f'/api/publish/receipts/{rid}').json()
    assert result['outcome'] == 'published' and result['url'] == URL
    assert result['completionHandled'] is True and result['notification']['state'] == 'sent'
    assert len(mail) == 1 and mail[0]['url'] == URL and mail[0]['receipt_id'] == rid
    assert mail[0]['summary'] == '概要'
    assert json.loads(namespace['SCHEDULE_FILE'].read_text(encoding='utf-8'))[0]['receiptId'] == rid
    namespace['_complete_publish_receipt'](result)
    assert client.post(f'/api/publish/receipts/{rid}/verify').status_code == 409
    assert len(mail) == 1 and checks == [rid] and len(calls) == 1


def test_recovered_effect_claim_rechecks_work_ownership_before_calendar_or_mail(api, monkeypatch):
    client, namespace, calls, _ = api
    store = namespace['_publish_receipt_store']()
    store.create(RID, 'xiaohongshu', '原发布任务')
    store.update(RID, {'outcome': 'submitted', 'state': 'finished', 'contentId': CID})
    duplicate_id = 'b' * 32
    store.create(duplicate_id, 'xiaohongshu', '相同作品的另一回执')
    store.update(duplicate_id, {'outcome': 'submitted', 'state': 'finished'})
    real_write = publish_receipts.local_records.write
    writes = []

    def fail_first_write(*args, **kwargs):
        writes.append(True)
        if len(writes) == 1:
            raise publish_receipts.local_records.RecordError('isolated transient write failure')
        return real_write(*args, **kwargs)

    monkeypatch.setattr(publish_receipts.local_records, 'write', fail_first_write)
    mail = []
    namespace['_notify_email_completion'] = lambda **kwargs: mail.append(kwargs) or {'state': 'sent'}
    volatile = namespace['_save_publish_receipt'](duplicate_id, {**checked(), 'completionPending': True})
    assert volatile['outcome'] == 'published' and volatile['storageWarning']
    result = namespace['_complete_publish_receipt'](volatile)
    assert len(writes) == 2 and not mail and not calls
    assert result['outcome'] == 'unverified' and not result['url']
    assert result['notification']['state'] == 'skipped' and not result.get('storageWarning')
    assert result['verification']['state'] == 'paused'
    assert not namespace['SCHEDULE_FILE'].exists()
    assert client.get(f'/api/publish/receipts/{duplicate_id}').json() == result
    assert store.get(RID)['contentId'] == CID


def test_restarted_worker_disk_failure_keeps_full_receipt_and_releases_platform(api, monkeypatch):
    client, namespace, calls, _ = api
    store = namespace['_publish_receipt_store']()
    store.create(RID, 'xiaohongshu', '重启核实')
    store.update(RID, {'outcome': 'submitted', 'state': 'finished', 'contentId': CID,
                      'verification': {'state': 'waiting', 'automatic': True, 'attempts': 0,
                                       'nextCheckAt': followup.iso(time.time() - 1)}})
    assert not namespace['_PUBLISH_VOLATILE']
    service = namespace['_publish_verification_service']()
    readers = []
    service.run_check = lambda *_: readers.append(True) or checked()
    def failed_write(*_):
        raise publish_receipts.local_records.RecordError('PRIVATE_DISK_FAILURE')
    monkeypatch.setattr(publish_receipts.local_records, 'write', failed_write)
    assert not service.tick() and not readers
    assert not namespace['_PUBLISH_ACTIVE']
    row = client.get(f'/api/publish/receipts/{RID}').json()
    assert row['platform'] == 'xiaohongshu' and row['title'] == '重启核实' and row['storageWarning']
    assert 'PRIVATE_DISK_FAILURE' not in json.dumps(row)


def test_a_moderation_update_is_visible_even_when_the_submission_is_old(harness):
    h = harness
    other = 'b' * 32
    h.store.create(other, 'zhihu', 'newer task')
    h.store.update(other, {'outcome': 'published'})
    h.store.update(RID, checked())
    assert h.store.recent(1)[0]['receiptId'] == RID


@pytest.fixture(scope='module')
def reader_module():
    sys.path.insert(0, str(ROOT / 'skills/shared/scripts'))
    spec = importlib.util.spec_from_file_location('isolated_readonly_publish', ROOT / 'skills/shared/scripts/verify_publish.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_read_only_reader_does_not_substitute_a_same_title_work(reader_module):
    now = int(time.time() * 1000)
    work = reader_module.readback.WorkItem('new-id', '相同标题', 'published', now)
    assert reader_module.identify_work([work], title='相同标题', since_ms=now, content_id='old-id') is None
    assert reader_module.identify_work([work, work], title='相同标题', since_ms=now) is None
    assert reader_module.identify_work([work], title='相同标', since_ms=now) is None
    assert reader_module.identify_work([work], title='相同标题', since_ms=now + 1001) is None
    assert reader_module.identify_work([work], title='相同标题', since_ms=now - 5000, until_ms=now - 1001) is None
    assert reader_module.identify_work([work], title='相同标题', since_ms=now) is work


def test_read_only_cli_rejects_publish_flags_and_emits_correlated_receipt(reader_module, monkeypatch, capsys):
    with pytest.raises(SystemExit) as error:
        reader_module.main(['--exec'])
    assert error.value.code == 2
    monkeypatch.setenv('EASEL_PUBLISH_RECEIPT_ID', RID)
    monkeypatch.setattr(reader_module, 'read_current_works', lambda _: [
        reader_module.readback.WorkItem('BV1xx411c7mD', 'older title', 'published')])
    code = reader_module.main(['--platform', 'bilibili', '--title', 'edited title', '--since-ms',
                               str(int(time.time() * 1000)), '--content-id', 'BV1xx411c7mD'])
    result = publish_receipts.parse_result('bilibili', RID, capsys.readouterr().out, code)
    assert result['outcome'] == 'published' and result['url'].endswith('/BV1xx411c7mD')

"""Transcript receipts adopted into a journal keep one turn-wide order."""
import json

from easel.execution_store import ExecutionStore, adopt, read_snapshot


def receipt(row_id, name, **patch):
    row = {'id': row_id, 'name': name, 'kind': 'search', 'status': 'running',
           'command': '', 'path': '', 'cwd': '', 'output': '', 'diff': '',
           'truncated': {}, 'source': 'transcript'}
    row.update(patch)
    return row


def test_ingest_adds_rows_and_orders_the_timeline(tmp_path):
    store = ExecutionStore(tmp_path, 's', 't')
    assert store.ingest([receipt('a', 'web_search', query='topic'), receipt('b', 'web_fetch', url='https://x.test')])
    snapshot = store.snapshot()
    assert [row['id'] for row in snapshot['operations']] == ['a', 'b']
    assert [entry['operationId'] for entry in snapshot['timeline']] == ['a', 'b']
    assert [entry['order'] for entry in snapshot['timeline']] == sorted(
        entry['order'] for entry in snapshot['timeline'])
    assert store.ingest([receipt('a', 'web_search', query='topic')]) is False


def test_ingest_keeps_progress_between_operations(tmp_path):
    store = ExecutionStore(tmp_path, 's', 't')
    store.progress('等待模型事件')
    store.ingest([receipt('a', 'web_search')])
    store.progress('工具返回后继续生成（第 2 步）')
    store.ingest([receipt('b', 'exec', kind='command', command='echo')])
    assert [entry['type'] for entry in store.timeline] == ['progress', 'operation', 'progress', 'operation']
    orders = [row['order'] for row in store.snapshot()['operations']]
    assert orders == sorted(orders)


def test_ask_user_waiting_state_is_persisted_and_cleared(tmp_path):
    store = ExecutionStore(tmp_path, 's', 't')
    store.ingest([receipt('ask-call', 'ask_user')])

    waiting = store.waiting_for_user(True)
    assert waiting['operations'][0]['waitingForUser'] is True
    assert read_snapshot(tmp_path, 's', 't')['operations'][0]['waitingForUser'] is True

    resumed = store.waiting_for_user(False)
    assert resumed['operations'][0]['waitingForUser'] is False
    assert store.waiting_for_user(False) is None


def test_ingest_never_regresses_a_finished_receipt(tmp_path):
    store = ExecutionStore(tmp_path, 's', 't')
    store.ingest([receipt('a', 'web_search')])
    assert store.ingest([receipt('a', 'web_search', status='failed', output='web_search is disabled',
                                 elapsedSeconds=0.4)])
    row = store.snapshot()['operations'][0]
    assert row['status'] == 'failed' and row['output'] == 'web_search is disabled'
    assert store.ingest([receipt('a', 'web_search', status='running', output='')]) is False
    row = store.snapshot()['operations'][0]
    assert row['status'] == 'failed' and row['output'] == 'web_search is disabled'
    # A late transcript read can still add detail to a finished row.
    assert store.ingest([receipt('a', 'web_search', status='failed', output='web_search is disabled',
                                 webSources=[{'url': 'https://x.test', 'title': 'X'}])])
    assert store.snapshot()['operations'][0]['webSources'][0]['url'] == 'https://x.test'


def test_ingest_persists_and_reloads_with_the_same_order(tmp_path):
    store = ExecutionStore(tmp_path, 's', 't')
    store.progress('开始')
    store.ingest([receipt('a', 'web_search', query='topic')])
    store.finish()
    saved = read_snapshot(tmp_path, 's', 't')
    assert [row['id'] for row in saved['operations']] == ['a']
    assert saved['operations'][0]['status'] == 'unconfirmed'
    assert [entry['type'] for entry in saved['timeline']] == ['progress', 'operation']
    reopened = ExecutionStore(tmp_path, 's', 't')
    assert reopened.ingest([receipt('b', 'web_fetch')])
    assert [entry['operationId'] for entry in reopened.timeline if entry['type'] == 'operation'] == ['a', 'b']


def test_ingest_ignores_rows_without_an_id_and_other_turn_payloads(tmp_path):
    store = ExecutionStore(tmp_path, 's', 't')
    assert store.ingest([{'name': 'web_search'}, {'id': ''}, 'not-a-row', None]) is False
    assert store.snapshot()['operations'] == [] and store.timeline == []
    assert store.ingest(None) is False


def test_adopt_keeps_booleans_zero_and_existing_provenance():
    existing = {'id': 'a', 'status': 'running', 'source': 'gateway', 'truncated': {'output': False}}
    merged = adopt(existing, {'id': 'a', 'status': 'completed', 'source': 'transcript',
                              'exitCode': 0, 'contentHidden': True, 'truncated': {'output': True}})
    assert merged['status'] == 'completed' and merged['source'] == 'gateway'
    assert merged['exitCode'] == 0 and merged['contentHidden'] is True
    assert merged['truncated'] == {'output': True}
    assert existing['status'] == 'running'


def test_store_file_stays_readable_json(tmp_path):
    store = ExecutionStore(tmp_path, 's', 't')
    store.ingest([receipt('a', 'web_search', query='主题')])
    written = list((tmp_path / '_execution').glob('*.json'))
    assert len(written) == 1
    saved = json.loads(written[0].read_text(encoding='utf-8'))
    assert saved['operations'][0]['query'] == '主题'
    assert saved['timeline'][0]['operationId'] == 'a'

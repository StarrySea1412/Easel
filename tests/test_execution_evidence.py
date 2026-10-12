import json
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

from easel.execution import begin, returned, codex_rows, page
from easel.execution_store import ExecutionStore, read
from easel.codex_service import CodexService


def test_real_command_exit_output_and_file_write(tmp_path):
    target = tmp_path / 'actual.txt'
    script = "from pathlib import Path;Path('actual.txt').write_text('verified');print('observed stdout');raise SystemExit(1)"
    started = time.time()
    result = subprocess.run([sys.executable, '-c', script], cwd=tmp_path, capture_output=True, text=True)
    row = begin('chat', 'turn', 'tool', 'exec', {'command': script, 'cwd': str(tmp_path)}, started)
    returned(row, {'isError': False, 'content': result.stdout, 'details': {'status': 'completed', 'exitCode': result.returncode}}, time.time())
    assert row['status'] == 'failed' and row['exitCode'] == 1
    assert row['cwd'] == str(tmp_path) and row['output'].strip() == 'observed stdout'
    assert target.read_text() == 'verified' and row['elapsedSeconds'] >= 0


def test_background_tool_return_is_not_process_completion_and_sensitive_output_hidden():
    row = begin('s', 't', 'c', 'exec', {'command': 'sleep', 'cwd': 'workspace'})
    returned(row, {'content': 'background', 'details': {'status': 'running', 'sessionId': 'child'}})
    assert row['status'] == 'running' and row['processSessionId'] == 'child'
    returned(row, {'details': {'status': 'completed', 'exitCode': 0}, 'content': 'done'})
    assert row['status'] == 'completed' and row['exitCode'] == 0
    private = begin('s', 't', 'p', 'read', {'path': '.env'})
    returned(private, {'isError': False, 'content': 'PRIVATE', 'details': {'diff': '+PRIVATE'}})
    assert private['contentHidden'] and private['output'] == private['diff'] == ''


def test_live_gateway_updates_deduplicate_persist_and_keep_final(tmp_path):
    store = ExecutionStore(tmp_path, 'chat', 'turn')
    def emit(seq, phase, **data):
        return store.consume({'stream': 'tool', 'seq': seq, 'data': {'phase': phase, 'toolCallId': 'c', 'name': 'exec', **data}})
    assert emit(1, 'start', args={'command': 'python task.py', 'cwd': 'workspace'})
    emit(2, 'update', partialResult={'content': [{'text': 'live output'}], 'details': {'status': 'running'}})
    assert emit(2, 'update', partialResult={'content': 'duplicate'}) is None
    emit(3, 'result', isError=False, result={'content': 'terminal output', 'details': {'status': 'completed', 'exitCode': 0}})
    assert emit(4, 'update', partialResult={'content': 'stale'}) is None
    store.finish()
    rows = read(tmp_path, 'chat', 'turn')
    assert len(rows) == 1 and rows[0]['status'] == 'completed' and rows[0]['output'] == 'terminal output'
    assert not read(tmp_path, 'other', 'turn')


def test_truncation_is_explicit_and_pages_cover_all_operations():
    row = begin('s', 't', 'c', 'exec', {'command': 'x' * 18000})
    returned(row, {'content': 'x' * 70000, 'isError': False})
    assert len(row['command']) == 16000 and len(row['output']) == 64000
    assert row['truncated']['command'] and row['truncated']['output']
    rows = [{'id': str(i)} for i in range(65)]
    latest = page(rows)
    older = page(rows, latest['nextBefore'])
    assert latest['total'] == 65 and latest['nextBefore'] == 25
    assert older['operations'] + latest['operations'] == rows and older['nextBefore'] is None


def test_codex_protocol_command_diff_reasoning_and_foreign_events(tmp_path):
    service = CodexService(tmp_path)
    state = {'sessionId': 's', 'turn_id': 't', 'threadId': 'thread', 'codexTurnId': 'turn',
             'items': [], 'text': '', 'thinking': '', 'pending': [], 'seq': 0}
    run = {'state': state, 'requests': {}}
    def event(method, **params):
        return service._consume(run, {'method': method, 'params': {'threadId': 'thread', 'turnId': 'turn', **params}})
    event('item/started', item={'id': 'cmd', 'type': 'commandExecution', 'command': 'python test.py', 'cwd': 'workspace', 'status': 'inProgress'})
    event('item/commandExecution/outputDelta', itemId='cmd', delta='actual protocol output')
    event('item/completed', item={'id': 'cmd', 'type': 'commandExecution', 'status': 'completed', 'exitCode': 1, 'durationMs': 1500})
    event('item/completed', item={'id': 'edit', 'type': 'fileChange', 'status': 'completed', 'changes': [{'path': 'file.py', 'kind': {'type': 'update'}, 'diff': '-old\n+new'}]})
    event('item/reasoning/summaryTextDelta', itemId='r', summaryIndex=0, delta='first')
    event('item/reasoning/summaryTextDelta', itemId='r', summaryIndex=1, delta='second')
    event('item/started', threadId='foreign', item={'id': 'private', 'type': 'commandExecution'})
    rows = service.execution('s', 't')['operations']
    assert len(rows) == 2 and rows[0]['status'] == 'failed' and rows[0]['exitCode'] == 1
    assert rows[0]['output'] == 'actual protocol output' and rows[0]['elapsedSeconds'] == 1.5
    assert rows[1]['diff'] == '-old\n+new' and rows[1]['changeKind'] == 'update'
    assert state['thinking'] == 'first\n\nsecond'
    replay = [json.loads(line) for line in service._event_path('s', 't').read_text(encoding='utf-8').splitlines()]
    assert any(e['event'] == 'execution' for e in replay)
    assert [e['id'] for e in replay] == list(range(1, len(replay) + 1))


def test_restart_preserves_evidence_without_replaying_model_request(tmp_path):
    service = CodexService(tmp_path)
    service._persist({'sessionId': 's', 'turn_id': 't', 'status': 'running', 'outcome': 'running',
        'seq': 0, 'items': [{'id': 'c', 'type': 'commandExecution', 'status': 'completed', 'command': 'done'},
                          {'id': 'active', 'type': 'commandExecution', 'status': 'inProgress', 'command': 'unknown'}], 'pending': [], 'startedAt': 1})
    factory = lambda _: pytest.fail('restart must not start a model')
    restored = CodexService(tmp_path, factory)
    state = restored.snapshot('s', 't')
    assert state['outcome'] == 'unconfirmed' and state['status'] == 'done'
    assert state['items'][0]['status'] == 'completed' and 'startedAt' not in state
    assert state['items'][1]['status'] == 'unconfirmed'
    replay = [json.loads(line) for line in restored._event_path('s', 't').read_text(encoding='utf-8').splitlines()]
    assert replay[0]['event'] == 'execution'
    assert replay[0]['data']['operations'][1]['status'] == 'unconfirmed'


def test_gateway_tool_callbacks_require_exact_run_and_session():
    from easel.gateway_agent import GatewayAgentProc
    seen = []
    class Client:
        def _rpc(self, method, params, **kw):
            kw['on_accepted']({'runId': 'own'})
            for run, session in [('foreign', 'session'), ('own', 'foreign'), ('own', 'session')]:
                kw['on_event']({'event': 'agent', 'payload': {'runId': run, 'sessionKey': session, 'stream': 'tool', 'data': {'phase': 'start'}}})
            return {'status': 'ok', 'result': {'payloads': []}}
        def close(self): pass
    proc = GatewayAgentProc(Client(), Client, {'idempotencyKey': 't', 'sessionKey': 'session', 'agentId': 'main'}, 5, on_tool=seen.append)
    assert proc.wait(1) == 0 and len(seen) == 1 and seen[0]['runId'] == 'own'

def test_background_process_poll_completes_original_and_empty_receipt_keeps_output(tmp_path):
    store = ExecutionStore(tmp_path, 's', 't')
    def emit(call, phase, **data):
        return store.consume({'stream': 'tool', 'data': {'phase':phase,'toolCallId':call,**data}})
    emit('exec','start',name='exec',args={'command':'run'})
    emit('exec','result',result={'content':'real live output','details':{'status':'running','sessionId':'child'}})
    emit('poll','start',name='process',args={'sessionId':'child'})
    emit('poll','result',result={'details':{'status':'completed','exitCode':1}})
    rows=read(tmp_path,'s','t')
    assert rows[0]['status']=='failed' and rows[0]['exitCode']==1
    assert rows[0]['output']=='real live output'

def test_codex_progress_is_separate_from_final_and_truncation_is_visible(tmp_path):
    service=CodexService(tmp_path)
    state={'sessionId':'s','turn_id':'t','threadId':'thread','codexTurnId':'turn','items':[],
           'text':'','thinking':'','pending':[],'seq':0}
    run={'state':state,'requests':{}}
    def emit(method,**params):
        service._consume(run,{'method':method,'params':{'threadId':'thread','turnId':'turn',**params}})
    emit('item/started',item={'id':'progress','type':'agentMessage','phase':'commentary','text':''})
    emit('item/agentMessage/delta',itemId='progress',delta='checking files')
    assert state['text']==''
    emit('item/completed',item={'id':'progress','type':'agentMessage','phase':'commentary','text':'checking files'})
    emit('item/completed',item={'id':'final','type':'agentMessage','phase':'final_answer','text':'delivered'})
    emit('item/completed',item={'id':'c','type':'commandExecution','status':'completed','aggregatedOutput':'x'*70000,'exitCode':0})
    emit('item/completed',item={'id':'f','type':'fileChange','status':'completed','changes':[{'path':'a.py','diff':'+'*70000}]})
    value=service.execution('s','t')
    assert state['text']=='delivered' and value['progress']==['checking files']
    assert value['operations'][0]['truncated']['output'] and value['operations'][1]['truncated']['diff']


def test_codex_relative_artifact_is_mapped_only_inside_current_output_root(tmp_path):
    service = CodexService(tmp_path)
    workspace = tmp_path / 'codex' / 'workspace'
    state = {'sessionId': 's', 'turn_id': 't', 'threadId': 'thread', 'codexTurnId': 'turn',
             'workspace': str(workspace), 'items': [], 'text': '', 'thinking': '', 'pending': [], 'seq': 0}
    run = {'state': state, 'requests': {}}
    service._consume(run, {'method': 'item/completed', 'params': {'threadId': 'thread', 'turnId': 'turn',
        'item': {'id': 'file', 'type': 'fileChange', 'status': 'completed',
                 'changes': [{'path': 'result.txt', 'diff': '+result'}, {'path': '../../../outside.txt', 'diff': '+outside'}]}}})
    rows = service.execution('s', 't')['operations']
    assert rows[0]['artifactPath'] == 'codex/workspace/result.txt'
    assert 'artifactPath' not in rows[1]
    replay = [json.loads(line) for line in service._event_path('s', 't').read_text(encoding='utf-8').splitlines()]
    observed = next(e['data'] for e in replay if e['event'] == 'execution')
    assert observed['operations'][0]['artifactPath'] == rows[0]['artifactPath']

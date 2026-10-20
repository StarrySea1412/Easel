import json
import subprocess
import sys
from pathlib import Path

from easel.execution_store import ExecutionStore, read_snapshot
from easel.plan_progress import _quote_argument, instructions, normalize, receipt_plan


PLAN = {'plan': [{'step': '读取资料', 'status': 'completed'}, {'step': '核验交付', 'status': 'in_progress'}]}


def test_planning_instructions_quote_script_path_on_posix():
    value = instructions()
    script = Path('sample scripts') / 'update_plan.py'
    assert 'update_plan.py' in value
    assert '--plan-file' in value
    assert _quote_argument(script, windows=False) == f"'{script}'"


def test_plan_validation_and_secret_redaction():
    assert normalize(PLAN)[1]['status'] == 'inProgress'
    assert normalize({'plan': [{'step': 'a', 'status': []}]}) is None
    assert normalize({'plan': [{'step': 'a', 'status': 'in_progress'}] * 2}) is None
    assert normalize({'plan': [{'step': 'a', 'status': 'guessed'}]}) is None
    assert normalize({'plan': [{'step': 'a', 'status': 'pending'}] * 33}) is None
    assert 'sk-secret12345678' not in normalize({'plan': [{'step': 'test sk-secret12345678', 'status': 'pending'}]})[0]['step']


def test_exact_command_marker_only_not_page_prose_or_failed_tool():
    text = 'EASEL_PLAN ' + json.dumps(PLAN)
    assert receipt_plan('exec', {}, {'content': [{'type': 'text', 'text': text}]}) == normalize(PLAN)
    assert receipt_plan('browser', {}, {'content': text}) is None
    assert receipt_plan('exec', {}, {'content': 'quoted ' + text}) is None
    assert receipt_plan('exec', {}, {'content': text, 'isError': True}) is None
    assert receipt_plan('TodoWrite', {'todos': [{'content': 'done', 'status': 'pending'}]}, {})[0]['status'] == 'pending'


def event(seq, phase, name='update_plan', args=None, result=None):
    return {'seq': seq, 'stream': 'tool', 'data': {'phase': phase, 'toolCallId': 'plan-call', 'name': name, 'args': args, 'result': result}}


def test_plan_is_accepted_after_successful_receipt_and_survives_restart(tmp_path):
    store = ExecutionStore(tmp_path, 's1', 't1')
    store.consume(event(1, 'start', args=PLAN))
    assert store.snapshot()['plan'] == []
    store.consume(event(2, 'end', result={'content': 'ok'}))
    assert store.snapshot()['plan'] == normalize(PLAN)
    store.finish()
    assert ExecutionStore(tmp_path, 's1', 't1').snapshot()['plan'][1]['status'] == 'inProgress'
    assert read_snapshot(tmp_path, 's2', 't1') == {}


def test_failed_native_plan_and_arbitrary_text_never_complete_steps(tmp_path):
    store = ExecutionStore(tmp_path, 's1', 't1')
    store.consume(event(1, 'start', args=PLAN))
    store.consume(event(2, 'end', result={'isError': True, 'content': 'failed'}))
    store.progress('all done, 100%')
    store.finish()
    assert store.snapshot()['plan'] == []


def test_namespaced_native_tool_uses_its_successful_receipt(tmp_path):
    store = ExecutionStore(tmp_path, 's1', 't1')
    store.consume(event(1, 'start', name='functions.update_plan', args=PLAN))
    store.consume(event(2, 'end', name='functions.update_plan', result={'content': 'ok'}))
    assert store.snapshot()['plan'] == normalize(PLAN)


def test_cli_produces_real_receipt_consumed_and_persisted(tmp_path):
    source = tmp_path / 'plan.json'
    source.write_text(json.dumps(PLAN), encoding='utf-8')
    script = Path(__file__).resolve().parents[1] / 'skills/shared/scripts/update_plan.py'
    result = subprocess.run([sys.executable, str(script), '--plan-file', str(source)], capture_output=True, text=True, check=True)
    store = ExecutionStore(tmp_path, 'real-script', 'turn')
    store.consume(event(1, 'start', name='exec', args={'command': 'update_plan.py'}))
    store.consume(event(2, 'end', result={'content': result.stdout, 'details': {'exitCode': 0}}))
    assert read_snapshot(tmp_path, 'real-script', 'turn')['plan'] == normalize(PLAN)

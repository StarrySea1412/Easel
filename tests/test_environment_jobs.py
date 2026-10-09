"""Exercise the installation queue with an isolated fake installer process."""
import importlib.util
from pathlib import Path
import sys
import time

spec = importlib.util.spec_from_file_location('environment_install', Path(__file__).parents[1] / 'web/environment_install.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def wait_for(service, job_id):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        job = service.get(job_id)
        if job['state'] not in module.ACTIVE_STATES:
            return job
        time.sleep(.02)
    raise AssertionError('fake installer did not settle')


def test_queue_reconnect_dedup_retry_and_redacted_logs(tmp_path):
    script = tmp_path / 'installer.py'
    script.write_text('''import json,sys,time
from pathlib import Path
tool=sys.argv[-1]
print('EASEL_INSTALL_EVENT '+json.dumps({'stage':'installing','label':'fake phase','strategyIndex':1,'strategyCount':1}),file=sys.stderr,flush=True)
print('https://user:password@example.test/file?token=private',file=sys.stderr,flush=True)
time.sleep(.3)
marker=Path('retry.marker')
failed=tool=='retry' and not marker.exists()
if tool=='retry': marker.touch()
print(json.dumps({'results':[{'id':tool,'state':'fail' if failed else 'ok','detail':'network connection failed' if failed else 'verified','version':'test'}]}))
''', encoding='utf-8')
    catalog = {item: {'name': item, 'install': [('fake', [], 2)]} for item in ('first', 'retry')}
    service = module.EnvironmentInstalls(script, tmp_path, sys.executable, tmp_path)
    initial = service.enqueue(['first', 'retry'], catalog)
    assert service.enqueue(['first'], catalog)['jobId'] == initial['jobs'][0]['jobId']
    assert len(service.list()['jobs']) == 2
    first = wait_for(service, initial['jobs'][0]['jobId'])
    failed = wait_for(service, initial['jobs'][1]['jobId'])
    assert first['state'] == 'ok' and failed['state'] == 'fail'
    assert failed['started'] >= first['ended']
    assert first['strategyIndex'] == 1
    assert 'password' not in '\n'.join(first['lines'])
    assert 'private' not in '\n'.join(first['lines'])
    retry = service.retry(failed['jobId'], catalog)
    final = wait_for(service, retry['jobId'])
    assert final['state'] == 'ok' and final['attempt'] == 2 and final['retryOf'] == failed['jobId']
    assert service.get(failed['jobId'])['state'] == 'fail'


def test_unknown_tool_never_launches_a_process(tmp_path):
    service = module.EnvironmentInstalls(tmp_path / 'missing.py', tmp_path, sys.executable, tmp_path)
    try:
        service.enqueue(['arbitrary-command'], {})
    except ValueError:
        pass
    else:
        raise AssertionError('unknown tool was accepted')
    assert service.list()['jobs'] == []

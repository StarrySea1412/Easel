"""Linux process-group acceptance; synthetic work only, no external requests.

Run inside the candidate image: python /candidate/tests/runtime_shutdown_native.py
"""
import base64
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time

import httpx

from easel.runtime_host import ROOT, RuntimeManager, locked, TOKEN_HEADER, CONTEXT_HEADER
import easel.runtime_host as host


def wait(predicate):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if predicate(): return
        time.sleep(.05)
    raise AssertionError('native process deadline')


def main():
    assert sys.platform == 'linux'
    with tempfile.TemporaryDirectory(prefix='easel-shutdown-native-') as directory:
        root = Path(directory)
        (root / 'fixture_shutdown.py').write_text('''
import asyncio, os
from pathlib import Path
from fastapi import FastAPI
root=Path(os.environ['EASEL_DATA_DIR']);app=FastAPI();runs=set()
def runtime_busy():return bool(runs)
@app.post('/run')
async def run():
    (root/'dispatches').write_text('one')
    async def execute():
        while not (root/'release').exists():await asyncio.sleep(.025)
        (root/'result').write_text('original-completed');runs.clear()
    task=asyncio.create_task(execute());runs.add(task)
    return {'accepted':True}
''')
        environment = {**os.environ, 'EASEL_DATA_DIR': str(root), 'EASEL_RUNTIME_APP': 'fixture_shutdown:app',
            'PYTHONPATH': str(root) + os.pathsep + str(ROOT), 'EASEL_PORT': '0'}
        manager = RuntimeManager(root, environment)
        state = manager.ensure(45)
        headers = {TOKEN_HEADER.decode(): state['token'], CONTEXT_HEADER.decode():
            base64.urlsafe_b64encode(json.dumps({'scheme': 'http', 'client': ['127.0.0.1', 1],
                'server': ['localhost', 80], 'root_path': ''}).encode()).decode()}
        url = f"http://127.0.0.1:{state['port']}"
        with httpx.Client(trust_env=False) as client:
            assert client.post(url + '/run', headers=headers).status_code == 200
        gateway_code = '''import os,signal,sys,time
from pathlib import Path
root=Path(sys.argv[1])
def stop(*_):
 assert (root/'result').read_text()=='original-completed'
 time.sleep(.2)
 (root/'gateway-flushed').write_text('yes');raise SystemExit(0)
signal.signal(signal.SIGTERM,stop)
(root/'gateway-ready').touch()
while True:time.sleep(.05)
'''
        children = [subprocess.Popen([sys.executable, '-c', gateway_code, str(root)], start_new_session=True),
            subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'], start_new_session=True)]
        failures = []
        def release():
            try:
                wait(lambda: manager.control(state)['draining'])
                with httpx.Client(trust_env=False) as client:
                    assert client.post(url + '/run', headers=headers).status_code == 503
                assert children[0].poll() is None
                (root / 'release').touch()
            except BaseException as error: failures.append(error)
        thread = threading.Thread(target=release)
        try:
            wait(lambda: (root / 'gateway-ready').exists())
            spec = importlib.util.spec_from_file_location('native_supervisor', ROOT / 'deployment/138/supervisor.py')
            module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            host.RuntimeManager = lambda: manager
            module.children = children
            signal.signal(signal.SIGTERM, module.stop)
            os.kill(os.getpid(), signal.SIGTERM);os.kill(os.getpid(), signal.SIGTERM)
            thread.start()
            assert module.stopping and module.shutdown_children()
            thread.join(5)
            assert not thread.is_alive() and not failures, failures
            assert not locked(manager.directory / 'runtime.lock')
            assert (root / 'dispatches').read_text() == 'one'
            assert (root / 'gateway-flushed').read_text() == 'yes'
            assert children[0].returncode == 0
            print(json.dumps({'nativeShutdown':'passed','dispatches':1,'newAdmission':503,
                'ownerExited':True,'gatewayFlushed':True,'duplicateSignals':'idempotent'}))
        finally:
            (root / 'release').touch()
            for child in children:
                if child.poll() is None:os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)


if __name__ == '__main__': main()

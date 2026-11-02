"""Container acceptance: installed CLI + plugin + real tool, synthetic HTTP model.

Run with Python in the fixed Easel Linux image. Uses temporary state/data only.
"""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import threading

from easel.artifacts import ArtifactStore
from easel.image_jobs import ImageJobs


def main():
    requests = []
    exhausted = os.environ.get('EASEL_NATIVE_FAILURE_MODE') == 'exhausted'
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append(request)
            step = len(requests)
            values = {
                1: {'operation': 'begin', 'requestId': 'native-fixture', 'filename': 'fixture.md'},
                2: None,
                3: {'operation': 'append', 'requestId': 'native-fixture', 'sequence': 0, 'text': 'EASEL_NATIVE_RECOVERY_OK\n'},
                4: {'operation': 'commit', 'requestId': 'native-fixture', 'expectedChunks': 1},
                5: {'ticket': ticket, 'files': [str(data / 'outputs/artifacts' /
                     hashlib.sha256(b'native-recovery-fixture').hexdigest()[:20] / 'fixture.md')]},
                6: {'ticket': ticket, 'requestId': 'native-image-fixture', 'prompt': 'Synthetic cover fixture'},
                7: {'ticket': ticket, 'requestId': 'native-image-fixture', 'prompt': 'Synthetic cover fixture'},
            }
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            def send(delta, finish=None):
                self.wfile.write(('data: ' + json.dumps({'id': 'fixture', 'object': 'chat.completion.chunk',
                    'model': 'deepseek-v4.1-flash', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}) + '\n\n').encode())
            if step in values:
                arguments = '{"operation":"append"' if step == 2 or exhausted and step == 3 else json.dumps(values[step])
                send({'role': 'assistant', 'tool_calls': [{'index': 0, 'id': f'fixture-{step}', 'type': 'function',
                    'function': {'name': 'easel_generate_image' if step in (6, 7) else
                        'easel_present' if step == 5 else 'easel_write_artifact', 'arguments': arguments}}]})
                send({}, 'tool_calls')
            else:
                send({'role': 'assistant', 'content': 'EASEL_NATIVE_RECOVERY_OK'})
                send({}, 'stop')
            self.wfile.write(b'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}\n\ndata: [DONE]\n\n')

    with tempfile.TemporaryDirectory(prefix='easel-native-recovery-') as temporary:
        root = Path(temporary)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        state, data, workspace = root / 'state', root / 'data', root / 'workspace'
        for directory in [state, data, workspace]:
            directory.mkdir()
        (data / '.env').write_text('IMG_BASE_URL=http://127.0.0.1:1/v1\nIMG_MODEL=synthetic-image\nIMG_API_KEY=synthetic\n')
        store = ArtifactStore(data / 'outputs')
        ticket = store.bind('native-recovery-fixture', 'native-fixture-turn')
        config = {
            'gateway': {'mode': 'local'},
            'agents': {'defaults': {'workspace': str(workspace), 'model': {'primary': 'happycoding/deepseek-v4.1-flash'}}},
            'models': {'providers': {'happycoding': {'api': 'openai-completions', 'apiKey': 'synthetic',
                'baseUrl': f'http://127.0.0.1:{server.server_port}/v1', 'models': [
                    {'id': 'deepseek-v4.1-flash', 'name': 'Synthetic fixture', 'maxTokens': 16384, 'reasoning': False,
                     'contextWindow': 128000, 'input': ['text']}]}}},
            'memory': {'search': {'enabled': False}},
            'tools': {'toolSearch': False},
            'plugins': {'allow': ['easel-agent-safety'], 'load': {'paths': [os.environ.get('EASEL_RECOVERY_PLUGIN_PATH', '/app/openclaw/easel-agent-safety')]}},
        }
        path = state / 'openclaw.json'
        path.write_text(json.dumps(config))
        env = dict(os.environ, OPENCLAW_STATE_DIR=str(state), OPENCLAW_CONFIG_PATH=str(path),
                   EASEL_OPENCLAW_STATE_DIR=str(state), EASEL_DATA_DIR=str(data), EASEL_OPENCLAW_WORKSPACE=str(workspace),
                   EASEL_CODE_ROOT=os.environ.get('EASEL_NATIVE_CODE_ROOT', '/app'),
                   PYTHONPATH=str(Path(os.environ.get('EASEL_RECOVERY_PLUGIN_PATH', '/app/openclaw/easel-agent-safety')).parents[1]) + os.pathsep + os.environ.get('PYTHONPATH', ''))
        process = subprocess.run(['node', '/opt/openclaw/node_modules/openclaw/openclaw.mjs',
            'agent', '--local', '--agent', 'main', '--session-key', 'agent:main:native-recovery-fixture', '--json', '--timeout', '120',
            '--message', 'Synthetic isolated tool acceptance. Save the fixture, preserve receipts and finish.'],
            env=env, capture_output=True, text=True, timeout=150)
        server.shutdown()
        files = list((data / 'outputs').rglob('fixture.md')) if (data / 'outputs').exists() else []
        audit = data / 'logs/model-tool-recovery.jsonl'
        rows = [json.loads(line) for line in audit.read_text().splitlines()] if audit.exists() else []
        result = {'exitCode': process.returncode, 'modelRequests': len(requests), 'artifacts': len(files),
                  'malformedResponses': sum(row['outcome'] == 'malformed_tool_call' for row in rows),
                  'toolReceipts': [sum(m.get('role') == 'tool' for m in r['messages']) for r in requests],
                  'recoveryOutcomes': [row['outcome'] for row in rows],
                  'toolResults': [m.get('content') for m in (requests[-1]['messages'] if requests else []) if m.get('role') == 'tool'],
                  'artifactToolExposed': any(t.get('function', {}).get('name') == 'easel_write_artifact' for r in requests for t in r.get('tools', [])),
                  'pluginImportError': any(x in process.stderr + process.stdout for x in ['ERR_MODULE_NOT_FOUND', 'Cannot find module', 'Cannot find package', 'Invalid config'])}
        result['delivered'] = len(store.snapshot('native-recovery-fixture')['artifacts'])
        image_jobs = ImageJobs(data / 'outputs').list('native-recovery-fixture')
        result['queuedImages'] = len(image_jobs)
        if files:
            result['sha256'] = hashlib.sha256(files[0].read_bytes()).hexdigest()
            result['bytes'] = len(files[0].read_bytes())
        if process.returncode and not exhausted:
            result['diagnostic'] = re.sub(r'(?i)(token|password|api[_-]?key|authorization)([^\n]{0,200})', '[REDACTED]', (process.stderr + process.stdout)[-2200:])
        print(json.dumps(result))
        if exhausted:
            assert process.returncode != 0 and len(requests) == 3 and len(files) == 0, result
            assert result['toolReceipts'] == [0, 1, 1], result
            assert len(list((data / '_artifact_writes').rglob('manifest.json'))) == 1
            return
        assert process.returncode == 0 and len(requests) == 8 and len(files) == 1 and result['malformedResponses'] == 1, result
        assert result['toolReceipts'] == [0, 1, 1, 2, 3, 4, 5, 6] and result['delivered'] == 1, result
        assert len(image_jobs) == 1 and image_jobs[0]['phase'] == 'queued', result
        assert files[0].read_bytes() == b'EASEL_NATIVE_RECOVERY_OK\n'


if __name__ == '__main__':
    main()

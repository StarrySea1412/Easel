"""Installed OpenClaw CLI + real plugin against a loopback synthetic AI Hub.

Run inside the fixed Linux image; temporary state only, no paid model requests.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading


def main():
    mode = os.environ.get('EASEL_AIHUB_FIXTURE', 'reset-after-read')
    assert mode in {'reset', '502', 'reset-after-read', 'success'}
    requests = []
    with tempfile.TemporaryDirectory(prefix='easel-aihub-native-') as temporary:
        root = Path(temporary)
        workspace = root / 'workspace'
        workspace.mkdir()
        fixture = workspace / 'fixture.txt'
        fixture.write_text('SYNTHETIC_READ_RECEIPT')

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(request)
                step = len(requests)
                if mode == '502':
                    body = json.dumps({'error': {'message': 'Upstream service temporarily unavailable',
                                               'type': 'upstream_error'}}).encode()
                    self.send_response(502)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if mode == 'reset' or mode == 'reset-after-read' and step > 1:
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()

                def send(delta, finish=None):
                    self.wfile.write(('data: ' + json.dumps({'id': 'synthetic',
                        'object': 'chat.completion.chunk', 'model': 'kimi-k3.1-pro',
                        'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}) + '\n\n').encode())
                    self.wfile.flush()

                if step == 1:
                    send({'role': 'assistant', 'content': 'Reading the synthetic fixture.'})
                    send({'tool_calls': [{'index': 0, 'id': 'fixture-read', 'type': 'function',
                        'function': {'name': 'read', 'arguments': json.dumps({'path': str(fixture)})}}]})
                    send({}, 'tool_calls')
                else:
                    send({'role': 'assistant', 'content': 'SYNTHETIC_COMPLETE'})
                    send({}, 'stop')
                self.wfile.write(b'data: [DONE]\n\n')

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        state = root / 'state'
        state.mkdir()
        plugin = os.environ.get('EASEL_AIHUB_PLUGIN', '/app/openclaw/easel-agent-safety')
        config = {'gateway': {'mode': 'local'},
            'agents': {'defaults': {'workspace': str(workspace),
                'model': {'primary': 'aihub/kimi-k3.1-pro', 'fallbacks': ['aihub/forbidden-fallback']}}},
            'models': {'providers': {'aihub': {'api': 'openai-completions', 'apiKey': 'synthetic',
                'baseUrl': f'http://127.0.0.1:{server.server_port}/v1', 'models': [
                    {'id': name, 'name': 'Synthetic AI Hub', 'reasoning': False, 'maxTokens': 4096,
                     'contextWindow': 128000, 'input': ['text']}
                    for name in ['kimi-k3.1-pro', 'forbidden-fallback']]}}},
            'memory': {'search': {'enabled': False}}, 'tools': {'toolSearch': False},
            'plugins': {'allow': ['easel-agent-safety'], 'load': {'paths': [plugin]}}}
        path = state / 'openclaw.json'
        path.write_text(json.dumps(config))
        env = dict(os.environ, OPENCLAW_STATE_DIR=str(state), OPENCLAW_CONFIG_PATH=str(path),
            EASEL_OPENCLAW_STATE_DIR=str(state), EASEL_DATA_DIR=str(root / 'data'),
            EASEL_OPENCLAW_WORKSPACE=str(workspace), EASEL_CODE_ROOT='/app')
        timeout = None
        try:
            process = subprocess.run(['node', '/opt/openclaw/node_modules/openclaw/openclaw.mjs',
                'agent', '--local', '--agent', 'main', '--session-key', 'agent:main:aihub-synthetic',
                '--json', '--timeout', '90', '--message', 'Synthetic acceptance: read the fixture and finish.'],
                env=env, capture_output=True, text=True, timeout=120)
        except subprocess.TimeoutExpired as exc:
            timeout = exc
            process = subprocess.CompletedProcess(exc.cmd, 124, '', '')
        finally:
            server.shutdown()
        audit = root / 'data/logs/aihub-transport.jsonl'
        rows = [json.loads(line) for line in audit.read_text().splitlines()] if audit.exists() else []
        receipts = [sum(m.get('role') == 'tool' for m in r['messages']) for r in requests]
        result = {'fixture': mode, 'exitCode': process.returncode, 'requests': len(requests),
            'models': sorted({r['model'] for r in requests}), 'toolReceipts': receipts,
            'outcomes': [row['outcome'] for row in rows], 'realProviderCalls': 0,
            'pluginImportError': any(x in process.stdout + process.stderr for x in
                ['ERR_MODULE_NOT_FOUND', 'Cannot find package', 'Invalid config'])}
        print(json.dumps(result))
        if timeout:
            print(json.dumps({'timeout': True, 'outputTail': str(timeout.stderr or timeout.stdout)[-3500:]}))
        assert not result['pluginImportError'] and result['models'] == ['kimi-k3.1-pro'], result
        assert len(requests) == (2 if mode in {'success', 'reset-after-read'} else 1), result
        assert receipts == ([0, 1] if mode in {'success', 'reset-after-read'} else [0]), result
        assert (process.returncode == 0) == (mode == 'success'), result
        assert rows[-1]['outcome'] == ('completed' if mode == 'success' else 'request_failed_no_replay'), result
        assert all(row.get('automaticRetries', 0) == 0 for row in rows), result
        assert fixture.read_text() == 'SYNTHETIC_READ_RECEIPT'


if __name__ == '__main__':
    main()

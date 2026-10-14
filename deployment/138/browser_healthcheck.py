"""Check authenticated CDP without exposing browser credentials."""
import base64
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen
from websocket import create_connection

auth = json.loads(Path(os.environ['EASEL_BROWSER_AUTH_FILE']).read_text())
token = base64.b64encode((auth['username'] + ':' + auth['password']).encode()).decode()
try:
    with urlopen(Request('http://127.0.0.1:18801/json/version',
                        headers={'Authorization': 'Basic ' + token}), timeout=4) as response:
        value = json.loads(response.read(65536))
    socket = create_connection(value['webSocketDebuggerUrl'], timeout=3,
                               header=['Authorization: Basic ' + token], suppress_origin=True)
    counter = 0
    target = None
    def call(method, params=None, session=None):
        global counter
        counter += 1
        message = {'id': counter, 'method': method, 'params': params or {}}
        if session:
            message['sessionId'] = session
        socket.send(json.dumps(message))
        while True:
            result = json.loads(socket.recv())
            if result.get('id') == counter:
                if result.get('error'):
                    raise ValueError('CDP health request failed')
                return result.get('result', {})
    try:
        call('Browser.getVersion')
        target = call('Target.createTarget', {'url': 'about:blank'})['targetId']
        session = call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
        assert call('Runtime.evaluate', {'expression': '1 + 1', 'returnByValue': True}, session)['result']['value'] == 2
    finally:
        if target:
            call('Target.closeTarget', {'targetId': target})
        socket.close()
except Exception:
    raise SystemExit(1)

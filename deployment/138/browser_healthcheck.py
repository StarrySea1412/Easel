"""Check authenticated CDP without exposing browser credentials."""
import base64
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

auth = json.loads(Path(os.environ['EASEL_BROWSER_AUTH_FILE']).read_text())
token = base64.b64encode((auth['username'] + ':' + auth['password']).encode()).decode()
try:
    with urlopen(Request('http://127.0.0.1:18801/json/version',
                        headers={'Authorization': 'Basic ' + token}), timeout=4) as response:
        value = json.loads(response.read(65536))
    if not value.get('webSocketDebuggerUrl'):
        raise ValueError()
except Exception:
    raise SystemExit(1)

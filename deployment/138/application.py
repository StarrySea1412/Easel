"""Server-only policies. The local desktop app does not import this module."""
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / 'web')]
from web import app as workspace
from easel.server_access import ServerAccessMiddleware, AccessStore
from easel.runtime_limits import install_limits

store = AccessStore(Path(os.environ['EASEL_ACCESS_FILE']))
workspace.app.add_middleware(ServerAccessMiddleware, store=store,
    origins=workspace._LOCAL_ORIGINS,
    test_mode=os.environ.get('EASEL_DEPLOYMENT_MODE') == 'isolated-test')
install_limits(workspace)
if os.environ.get('EASEL_CODEX_ENABLED', '0') != '1':
    workspace._codex_service.runtime = lambda: {'available': False, 'options': [],
        'error': '此服务器未启用 Codex，请使用 OpenClaw。', 'skills': False, 'agentOffice': False}

app = workspace.app

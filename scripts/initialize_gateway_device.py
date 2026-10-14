"""Connect this installation's existing CLI identity during explicit startup.

The gateway decides whether local pairing is permitted. No identity copying,
manual approval RPC, scope upgrade or model request is performed here.
"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def initialize_device() -> bool:
    from easel.gateway_endpoint import gateway_host
    from easel.gateway_auth import resolve_credentials
    from easel.gateway_questions import GatewayClient

    if gateway_host() not in {'127.0.0.1', 'localhost', '[::1]'}:
        return False
    credentials = resolve_credentials()
    auth = {'password': credentials.password} if credentials.mode == 'password' else {'token': credentials.token}
    client = GatewayClient(timeout=10, scopes=['operator.admin'], client_id='cli', client_mode='cli', auth=auth)
    try:
        client.connect()
        return 'operator.admin' in client.granted_scopes
    except Exception:
        return False
    finally:
        client.close()


if __name__ == '__main__':
    ready = initialize_device()
    print('本副本设备连接已就绪。' if ready else '本副本设备连接尚未批准；请在对应 OpenClaw 网关完成设备授权。')
    raise SystemExit(0 if ready else 1)

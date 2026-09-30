"""Launcher port ownership and response identity contracts."""
from pathlib import Path
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from start_workspace import free_port, ready


def test_occupied_port_uses_other_available_port_without_stopping_owner():
    with socket.socket() as existing:
        existing.bind(("127.0.0.1", 0))
        existing.listen()
        port = existing.getsockname()[1]
        picked = free_port(port)
        assert picked != port
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            pass


@pytest.mark.parametrize("port", [0, -1, 65536])
def test_invalid_port_is_rejected(port):
    with pytest.raises(ValueError):
        free_port(port)


def test_ready_requires_matching_page_and_status_shape():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"gateway":{},"skills":[]}' if self.path == '/api/status' else b'Easel build')

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/"
        assert ready(url, b'Easel build')
        assert not ready(url, b'Other build')
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

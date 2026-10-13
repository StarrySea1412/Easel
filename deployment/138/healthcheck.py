"""Liveness only: model or channel outages do not restart a healthy Web."""
import urllib.request

with urllib.request.urlopen('http://127.0.0.1:7880/health/live', timeout=4) as response:
    assert response.status == 200


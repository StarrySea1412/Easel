"""Launch sandboxed Chromium and an internal authenticated CDP gateway."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

profile = tempfile.TemporaryDirectory(prefix='easel-sidecar-', dir='/tmp')
browser_home = Path(profile.name) / 'home'
browser_home.mkdir(mode=0o700)
os.environ['HOME'] = str(browser_home)
os.environ['XDG_CONFIG_HOME'] = str(browser_home / '.config')
os.environ['XDG_CACHE_HOME'] = str(browser_home / '.cache')
base = Path(__file__).resolve().parent
chrome = subprocess.Popen(['/opt/chromium/chromium-1243/chrome-linux64/chrome',
    '--headless', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=18800',
    '--user-data-dir=' + profile.name, 'about:blank'], start_new_session=True)
proxy = subprocess.Popen(['node', str(base / 'browser_cdp_proxy.mjs')], start_new_session=True)
stop = False

def stopping(*_):
    global stop
    stop = True

signal.signal(signal.SIGTERM, stopping)
signal.signal(signal.SIGINT, stopping)
try:
    while not stop and chrome.poll() is None and proxy.poll() is None:
        time.sleep(.25)
finally:
    for child in (proxy, chrome):
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
    for child in (proxy, chrome):
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    profile.cleanup()
sys.exit(0 if stop else 1)


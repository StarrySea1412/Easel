"""Prepare this server's independent workspace; preserve existing identity/config."""
import json
import os
from pathlib import Path
import secrets
import shutil

from easel.web_runtime_config import configure_web_runtime, configure_browser_runtime

ROOT = Path(os.environ.get('EASEL_ROOT', '/app'))
DATA = Path(os.environ.get('EASEL_DATA_DIR', '/data'))
STATE = Path(os.environ.get('EASEL_OPENCLAW_STATE_DIR', '/state/openclaw'))
WORKSPACE = Path(os.environ.get('EASEL_OPENCLAW_WORKSPACE', str(STATE / 'workspace')))


def bootstrap():
    os.umask(0o077)
    for folder in [DATA / 'outputs', DATA / 'profiles', DATA / 'logs', STATE, WORKSPACE,
                   Path(os.environ.get('XDG_CACHE_HOME', '/state/cache')), Path.home()]:
        folder.mkdir(parents=True, exist_ok=True)
    template = DATA / 'profiles/_template'
    if not template.exists():
        shutil.copytree(ROOT / 'profiles/_template', template)
    env_file = DATA / '.env'
    if not env_file.exists():
        env_file.write_text('', encoding='utf-8')
    config = STATE / 'openclaw.json'
    if not config.exists():
        value = {'gateway': {'mode': 'local', 'port': 18789, 'bind': 'loopback',
            'auth': {'mode': 'token', 'token': secrets.token_urlsafe(48)},
            'http': {'endpoints': {'chatCompletions': {'enabled': True}}}},
            # Custom OpenAI-compatible models may call catalog tools directly
            # instead of using OpenClaw 2026.9.6's deferred tool_call surface.
            # Expose direct schemas without changing the tool permission policy.
            'tools': {'toolSearch': False},
            'agents': {'defaults': {'workspace': str(WORKSPACE), 'maxConcurrent': 1,
                'subagents': {'maxConcurrent': 1}}}}
        value, _ = configure_web_runtime(value)
        config.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    model_file = Path(os.environ.get('EASEL_MODEL_BOOTSTRAP_FILE', '/run/secrets/model-bootstrap.json'))
    if model_file.is_file():
        value = json.loads(config.read_text(encoding='utf-8'))
        model = json.loads(model_file.read_text(encoding='utf-8'))
        if model.get('providers') and not value.get('models', {}).get('providers'):
            value['models'] = {'mode': 'merge', 'providers': model['providers']}
            value['agents']['defaults']['model'] = {'primary': model['primary']}
            config.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    browser_auth = os.environ.get('EASEL_BROWSER_AUTH_FILE')
    if browser_auth:
        value = json.loads(config.read_text(encoding='utf-8'))
        value, changes = configure_browser_runtime(value, json.loads(Path(browser_auth).read_text()))
        if changes:
            config.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    # OpenClaw 2026.9.6 owns identity creation in state/openclaw.sqlite.
    # Do not fabricate a retired device.json or modify its pairing tables.
    # Only server-managed directories are synchronized; state, MEMORY and identity stay.
    skill_destination = WORKSPACE / 'skills'
    skill_destination.mkdir(exist_ok=True)
    for source in (ROOT / 'skills/openclaw').iterdir():
        if not source.is_dir():
            continue
        destination = skill_destination / source.name
        if destination.exists():
            if destination.is_symlink():
                destination.unlink()
            else:
                shutil.rmtree(destination)
        shutil.copytree(source, destination)
    shared = WORKSPACE / 'shared'
    if shared.exists():
        if shared.is_symlink():
            shared.unlink()
        else:
            shutil.rmtree(shared)
    shutil.copytree(ROOT / 'skills/shared', shared)
    for source in (ROOT / 'openclaw/workspace').glob('*.md'):
        destination = WORKSPACE / source.name
        if destination.exists():
            destination.unlink()
        shutil.copyfile(source, destination)
    with (WORKSPACE / 'AGENTS.md').open('a', encoding='utf-8') as output:
        output.write('\n\n## Easel server paths\nProject code: `/app`; persistent data: `/data`.\n'
            'Use EASEL_DATA_DIR and the actual /data/.env for offline configuration checks. '
            'Save actual output files under /data/outputs/<topic>/; verify files exist before linking them.\n')
    for name, target in [('outputs', DATA / 'outputs'), ('easel-profiles', DATA / 'profiles')]:
        destination = WORKSPACE / name
        if destination.is_symlink():
            if destination.resolve() == target.resolve():
                continue
            destination.unlink()
        if destination.exists():
            raise RuntimeError('Unexpected workspace directory requires explicit migration: ' + name)
        destination.symlink_to(target, target_is_directory=True)
    print('Independent server workspace ready; credentials and device identity preserved.', flush=True)


if __name__ == '__main__':
    bootstrap()

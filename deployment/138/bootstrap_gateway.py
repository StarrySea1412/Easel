"""Prepare this server's independent workspace; preserve existing identity/config."""
import json
import os
from pathlib import Path
import secrets
import shutil

from easel.web_runtime_config import (configure_web_runtime, configure_browser_runtime,
                                      configure_free_search, configure_agent_safety_plugins)

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
        value, _ = configure_free_search(value)
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
    # Configure the shipped provider before Gateway loads its plugin registry.
    # Repair only the old Easel-created allowlist; operator restrictions survive.
    value = json.loads(config.read_text(encoding='utf-8'))
    allowed = value.get('plugins', {}).get('allow')
    legacy_allow = isinstance(allowed, list) and set(allowed) == {'easel-agent-safety'}
    value, search_changes = configure_free_search(value, allow_plugin=legacy_allow,
                                                  plugin_path=ROOT / 'deployment/138/free-search')
    value, guard_changed = configure_agent_safety_plugins(value, ROOT / 'openclaw/easel-agent-safety',
                                                         ROOT / 'deployment/138/free-search')
    if search_changes or guard_changed:
        config.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    # OpenClaw 2026.9.6 owns identity creation in state/openclaw.sqlite.
    # Do not fabricate a retired device.json or modify its pairing tables.
    # Only server-managed directories are synchronized; state, MEMORY and identity stay.
    skill_destination = WORKSPACE / 'skills'
    skill_destination.mkdir(exist_ok=True)
    skill_sources = {}
    for skill_root in (ROOT / 'skills/openclaw', ROOT / 'skills/builtin'):
        if skill_root.is_dir():
            for source in skill_root.iterdir():
                if source.is_dir():
                    skill_sources[source.name] = source
    for source in skill_sources.values():
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
    workspace_source = ROOT / 'agents/workspace'
    if not workspace_source.is_dir():
        workspace_source = ROOT / 'openclaw/workspace'
    for source in workspace_source.glob('*.md'):
        destination = WORKSPACE / source.name
        if destination.exists():
            destination.unlink()
        shutil.copyfile(source, destination)
    with (WORKSPACE / 'AGENTS.md').open('a', encoding='utf-8') as output:
        output.write('\n\n## Easel server paths\nProject code: `/app`; persistent data: `/data`.\n'
            'The /app source tree is read-only. Save one-off Python scripts and intermediate files '
            'alongside deliverables under /data/outputs/<topic>/, never under /app/scripts or skill source. '
            'Execute the saved script by its actual absolute path. Disposable temporary files may use /tmp.\n'
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

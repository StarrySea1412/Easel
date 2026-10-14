"""Key-free server web defaults and an explicit, non-destructive migration."""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path

PLUGIN_PATH = '/opt/openclaw/node_modules/@openclaw/duckduckgo-plugin'


def configure_web_runtime(value: dict, *, enable_search=False, allow_plugin=False) -> tuple[dict, list[str]]:
    """Fill missing defaults; explicit disabled search requires opt-in migration."""
    result = copy.deepcopy(value)
    changes = []
    search = result.get('tools', {}).get('web', {}).get('search', {})
    # Another provider or an explicit disabled setting remains operator-owned.
    if search.get('provider') not in (None, '', 'duckduckgo'):
        return result, changes
    if search.get('enabled') is False and not enable_search:
        return result, changes
    plugins = result.get('plugins', {})
    entry = plugins.get('entries', {}).get('duckduckgo', {})
    if plugins.get('enabled') is False or 'duckduckgo' in plugins.get('deny', []):
        return result, changes
    if entry.get('enabled') is False:
        return result, changes
    allowed = plugins.get('allow')
    if isinstance(allowed, list) and 'duckduckgo' not in allowed:
        if not allow_plugin:
            return result, changes
        allowed.append('duckduckgo')
        changes.append('plugins.allow: add duckduckgo (explicit opt-in)')
    search = result.setdefault('tools', {}).setdefault('web', {}).setdefault('search', {})
    plugins = result.setdefault('plugins', {})
    plugins.setdefault('entries', {})
    paths = plugins.setdefault('load', {}).setdefault('paths', [])
    if PLUGIN_PATH not in paths:
        paths.append(PLUGIN_PATH)
        changes.append('plugins.load.paths: add pinned DuckDuckGo plugin')
    if entry.get('enabled') is not True:
        plugins['entries'].setdefault('duckduckgo', {})['enabled'] = True
        changes.append('plugins.entries.duckduckgo.enabled: true')
    if search.get('provider') != 'duckduckgo':
        search['provider'] = 'duckduckgo'
        changes.append('tools.web.search.provider: duckduckgo')
    if search.get('enabled') is not True:
        search['enabled'] = True
        changes.append('tools.web.search.enabled: true')
    return result, changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path, help='Separate candidate; never overwrites live config.')
    parser.add_argument('--enable-search', action='store_true', help='Explicitly enable previously disabled search.')
    parser.add_argument('--allow-plugin', action='store_true', help='Explicitly extend a restrictive plugin allowlist.')
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        parser.error('The output must be a separate candidate file.')
    value = json.loads(args.input.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        parser.error('Configuration must be an object.')
    candidate, changes = configure_web_runtime(value, enable_search=args.enable_search, allow_plugin=args.allow_plugin)
    # Exclusive creation protects an existing candidate or an accidental live path.
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
        output.write(json.dumps(candidate, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'changedFields': changes, 'liveConfigModified': False}))


if __name__ == '__main__':
    main()

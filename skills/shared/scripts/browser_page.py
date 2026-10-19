#!/usr/bin/env python3
"""Operate the current Easel browser through the host, never a second browser."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, os.environ.get('EASEL_CODE_ROOT', str(Path(__file__).resolve().parents[3])))
from easel.browser_bridge import request
from easel.browser_runtime import BrowserError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--session', required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--args-json')
    source.add_argument('--args-file', type=Path)
    args = parser.parse_args()
    try:
        payload = json.loads(args.args_file.read_text(encoding='utf-8-sig') if args.args_file else args.args_json)
        result = request(args.session, payload)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get('job', {}).get('state', 'completed') == 'completed' else 1
    except (BrowserError, ValueError, OSError) as exc:
        print(json.dumps({'error':str(exc)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

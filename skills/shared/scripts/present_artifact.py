#!/usr/bin/env python3
"""Deliver existing files to the exact Easel chat turn; never generate or retry."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, os.environ.get('EASEL_CODE_ROOT', str(Path(__file__).resolve().parents[3])))
from easel.artifacts import ArtifactStore
from output_paths import OUTPUTS_DIR


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ticket', required=True)
    parser.add_argument('--file', action='append', required=True)
    parser.add_argument('--session')
    parser.add_argument('--call')
    args = parser.parse_args()
    try:
        values = ArtifactStore(OUTPUTS_DIR).present_ticket(args.ticket, [{'path': p} for p in args.file],
                                                          session=args.session, call=args.call)
        print(json.dumps({'ok': True, 'artifacts': values}, ensure_ascii=False))
    except (ValueError, OSError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Safely stage a delivered image without invoking a provider."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, os.environ.get('EASEL_CODE_ROOT', str(Path(__file__).resolve().parents[3])))
from easel.image_inspection import stage_owned_image

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--session', required=True)
    parser.add_argument('--path', required=True)
    args = parser.parse_args()
    data = os.environ.get('EASEL_DATA_DIR')
    state = os.environ.get('EASEL_OPENCLAW_STATE_DIR') or os.environ.get('OPENCLAW_STATE_DIR')
    if not data or not state:
        raise ValueError('Inspection runtime unavailable')
    target = stage_owned_image(Path(data) / 'outputs', Path(state), args.session, args.path)
    print(json.dumps({'path': str(target)}))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'error': 'Image ownership, file or staging validation failed'}))
        raise SystemExit(1)

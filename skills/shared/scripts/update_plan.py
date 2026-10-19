"""Emit a validated plan receipt for the current command tool (no network)."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from easel.plan_progress import MARKER, normalize


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan-file', required=True)
    args = parser.parse_args()
    path = Path(args.plan_file)
    if path.stat().st_size > 32000:
        parser.error('Plan file exceeds 32 KB')
    plan = normalize(json.loads(path.read_text(encoding='utf-8-sig')))
    if plan is None:
        parser.error('Expected 1-32 valid steps and at most one in_progress step')
    print(MARKER + json.dumps({'plan': plan}, ensure_ascii=True))


if __name__ == '__main__':
    main()

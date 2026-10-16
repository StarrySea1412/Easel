"""Local before-tool hook adapter. Arguments contain identities, never prompts."""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from easel.paths import data_root
from easel.task_store import TaskStore

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('session', 'run', 'call', 'tool'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    result = TaskStore(data_root(ROOT) / 'outputs').guard(args.session, args.run, args.call, args.tool)
    print(json.dumps(result, ensure_ascii=False))

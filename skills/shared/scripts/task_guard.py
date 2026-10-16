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
    store = TaskStore(data_root(ROOT) / 'outputs')
    if args.tool == '__update_progress':
        try:
            result = store.update_progress(args.session, args.call, json.load(sys.stdin)['steps'])
        except ValueError:
            result = {'ok':False, 'reason':'目标步骤更新未通过身份、状态或内容校验。'}
    else:
        result = store.guard(args.session, args.run, args.call, args.tool)
    print(json.dumps(result, ensure_ascii=False))

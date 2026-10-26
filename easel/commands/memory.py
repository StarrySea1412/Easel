"""Shared model/CLI entry: read or propose; activation stays in the workbench."""
import json
from easel.paths import data_root
from easel.profile_memory import MemoryStore


def run(args):
    store = MemoryStore(data_root())
    if args.action == 'propose':
        selected = {'kind': 'account', 'platform': args.platform, 'accountId': args.account} if args.platform else {'kind': 'profile'}
        value = store.propose(args.profile, {'text': args.text, 'scope': selected, 'source': {'type': 'manual'},
            'conditions': {'taskTypes': [args.task_type] if getattr(args, 'task_type', None) else [],
                'allKeywords': getattr(args, 'keyword', []) or [], 'excludeKeywords': getattr(args, 'exclude_keyword', []) or []}})
    elif args.action == 'extract-analysis':
        value = store.extract_analysis(args.profile, {'bindingId': args.binding})
    elif args.action == 'context':
        value = store.context(args.profile, args.query, args.platform, args.account, task_type=getattr(args, 'task_type', None))
    else:
        value = store.state(args.profile)
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


def register(sub):
    parser = sub.add_parser('memory', help='读取画像经验或提出待确认候选（不自动生效）')
    parser.add_argument('action', choices=['list', 'propose', 'context', 'extract-analysis'])
    parser.add_argument('--profile', required=True)
    parser.add_argument('--text', default='')
    parser.add_argument('--binding', help='已保存分析来源ID，仅提取待确认候选')
    parser.add_argument('--query', default='')
    parser.add_argument('--platform')
    parser.add_argument('--account')
    from easel.profile_memory import TASK_TYPES
    parser.add_argument('--task-type', choices=TASK_TYPES)
    parser.add_argument('--keyword', action='append', help='候选适用时必须包含的文字，可重复')
    parser.add_argument('--exclude-keyword', action='append', help='候选排除的文字，可重复')
    parser.set_defaults(func=run)

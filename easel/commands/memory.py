"""Shared model/CLI entry: read or propose; activation stays in the workbench."""
import json
from easel.paths import data_root
from easel.profile_memory import MemoryStore


def run(args):
    store = MemoryStore(data_root())
    if args.action == 'queue-run':
        value = store.queue_run(args.session, args.turn, {'text': args.text, 'quote': args.quote}, name=args.profile)
    elif args.action == 'propose':
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
    parser.add_argument('action', choices=['list', 'propose', 'context', 'extract-analysis', 'queue-run'])
    parser.add_argument('--profile', required=True)
    parser.add_argument('--text', default='')
    parser.add_argument('--binding', help='已保存分析来源ID，仅提取待确认候选')
    parser.add_argument('--session', help='已由宿主固定画像的任务会话')
    parser.add_argument('--turn', help='原任务轮次')
    parser.add_argument('--quote', default='', help='最终回复中的依据原文，不能自行确认生效')
    parser.add_argument('--query', default='')
    parser.add_argument('--platform')
    parser.add_argument('--account')
    from easel.profile_memory import TASK_TYPES
    parser.add_argument('--task-type', choices=TASK_TYPES)
    parser.add_argument('--keyword', action='append', help='候选适用时必须包含的文字，可重复')
    parser.add_argument('--exclude-keyword', action='append', help='候选排除的文字，可重复')
    parser.set_defaults(func=run)

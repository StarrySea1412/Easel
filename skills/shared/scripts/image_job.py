#!/usr/bin/env python3
"""Submit/read the durable host image queue; never pass keys in tool arguments."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, os.environ.get('EASEL_CODE_ROOT', str(Path(__file__).resolve().parents[3])))
from easel.artifacts import ArtifactStore
from easel.image_jobs import ImageJobs, read_config
from output_paths import OUTPUTS_DIR


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['submit', 'status'])
    parser.add_argument('--ticket', required=True)
    parser.add_argument('--session')
    parser.add_argument('--request-id')
    parser.add_argument('--prompt')
    parser.add_argument('--size', default='1024x1024')
    parser.add_argument('--job-id')
    args = parser.parse_args()
    try:
        session, turn = ArtifactStore(OUTPUTS_DIR).ticket_scope(args.ticket, session=args.session)
        jobs = ImageJobs(OUTPUTS_DIR)
        if args.action == 'status':
            result = jobs.get(args.job_id, session=session)
        else:
            if not args.request_id or not args.prompt:
                raise ValueError('提交必须提供固定request-id和提示词')
            result = jobs.submit({'prompt': args.prompt, 'size': args.size}, read_config(OUTPUTS_DIR.parent),
                                 session=session, turn=turn, request_id=args.request_id)
        print(json.dumps({'ok': True, 'job': result}, ensure_ascii=False))
        return 0
    except (ValueError, OSError):
        print(json.dumps({'ok': False, 'error': '任务未提交，请检查当前会话凭据、请求标识、参数和专用生图设置'}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

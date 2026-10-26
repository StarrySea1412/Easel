#!/usr/bin/env python3
"""Prepare a draft for user review; no platform operation or model request."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, os.environ.get('EASEL_CODE_ROOT', str(Path(__file__).resolve().parents[3])))
from easel.artifacts import ArtifactStore
from easel.creation_drafts import CreationDrafts
from output_paths import OUTPUTS_DIR


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ticket', required=True)
    parser.add_argument('--request-id', required=True)
    parser.add_argument('--body-file', required=True)
    parser.add_argument('--title', default='')
    parser.add_argument('--tags', default='')
    parser.add_argument('--platform', action='append', default=[])
    parser.add_argument('--media', action='append', default=[])
    parser.add_argument('--analysis-binding', default='')
    args = parser.parse_args()
    try:
        session, turn = ArtifactStore(OUTPUTS_DIR).ticket_scope(args.ticket)
        path = Path(args.body_file)
        if path.stat().st_size > 120000:
            raise ValueError('正文文件过大')
        draft = CreationDrafts(OUTPUTS_DIR).prepare(session, turn, {'requestId': args.request_id,
            'title': args.title, 'body': path.read_text(encoding='utf-8-sig'), 'tags': args.tags,
            'platforms': args.platform, 'media': args.media, 'analysisBindingId': args.analysis_binding})
        print(json.dumps({'ok': True, 'draft': draft, 'requiresUserConfirmation': True}, ensure_ascii=False))
        return 0
    except (ValueError, OSError, LookupError):
        print(json.dumps({'ok': False, 'error': '草稿未接受，请核对当前会话凭据、正文文件及本机素材。未执行发布。'}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

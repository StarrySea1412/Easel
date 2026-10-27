"""Queue a proposal for the server-bound run; never activate profile memory."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from easel.paths import data_root
from easel.profile_memory import MemoryStore


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', type=Path)
    parser.add_argument('--session', required=True)
    parser.add_argument('--turn', required=True)
    parser.add_argument('--proposal-file', required=True, type=Path)
    args = parser.parse_args()
    if args.proposal_file.stat().st_size > 12000:
        raise ValueError('经验提案文件过大')
    proposal = json.loads(args.proposal_file.read_text(encoding='utf-8-sig'))
    result = MemoryStore(args.data_root or data_root()).queue_run(args.session, args.turn, proposal)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, LookupError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

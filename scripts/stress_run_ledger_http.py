"""Run an isolated HTTP load test against the real run-ledger event handler."""
from __future__ import annotations

import argparse
import asyncio
from contextlib import contextmanager
import json
import platform
import socket
import statistics
import tempfile
import threading
import time
from collections import defaultdict
from pathlib import Path

import httpx
from fastapi import FastAPI
import uvicorn

from web import app as web
from web import run_ledger


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int((len(ordered) - 1) * fraction)))
    return ordered[index]


async def run_round(client: httpx.AsyncClient, *, workers: int, requests_per_round: int) -> dict:
    per_worker = requests_per_round // workers
    latencies: list[float] = []
    write_latencies: list[float] = []
    write_errors: list[str] = []
    stop_writer = threading.Event()
    started = time.perf_counter()

    def writer() -> None:
        index = 0
        while not stop_writer.is_set():
            write_started = time.perf_counter()
            try:
                run_ledger.mark(web._run_ledger_root(), 'stress-turn', event='concurrent_write', index=index)
                write_latencies.append((time.perf_counter() - write_started) * 1000)
            except Exception as exc:
                write_errors.append(type(exc).__name__)
            index += 1
            stop_writer.wait(0.02)

    writer_thread = threading.Thread(target=writer, name='ledger-stress-writer', daemon=True)
    writer_thread.start()

    async def worker() -> None:
        for _ in range(per_worker):
            request_started = time.perf_counter()
            response = await client.get('/api/chat/runs/stress-turn/events?after=0&limit=100')
            latencies.append((time.perf_counter() - request_started) * 1000)
            if response.status_code != 200:
                raise RuntimeError(f'HTTP {response.status_code}: {response.text[:200]}')
            page = response.json()
            if page.get('turnId') != 'stress-turn' or not page.get('events'):
                raise RuntimeError('The event endpoint returned an incomplete page')

    try:
        await asyncio.gather(*(worker() for _ in range(workers)))
    finally:
        stop_writer.set()
        writer_thread.join(timeout=15)
        if writer_thread.is_alive():
            write_errors.append('writer_timeout')
    elapsed = time.perf_counter() - started
    return {
        'requests': len(latencies),
        'rps': round(len(latencies) / elapsed, 1),
        'p50_ms': round(statistics.median(latencies), 2),
        'p95_ms': round(percentile(latencies, 0.95), 2),
        'p99_ms': round(percentile(latencies, 0.99), 2),
        'max_ms': round(max(latencies), 2),
        'writer_requests': len(write_latencies),
        'writer_failures': len(write_errors),
        'writer_rps': round(len(write_latencies) / elapsed, 1),
        'writer_p95_ms': round(percentile(write_latencies, 0.95), 2) if write_latencies else None,
        'writer_max_ms': round(max(write_latencies), 2) if write_latencies else None,
        'writer_errors': sorted(set(write_errors)),
        'elapsed_s': round(elapsed, 2),
    }


async def run_mode(client: httpx.AsyncClient, *, mode: str, workers: int,
                   requests_per_round: int, rounds: int) -> list[dict]:
    original_db = run_ledger._db
    if mode == 'begin_immediate_baseline':
        @contextmanager
        def old_read_lock(root, *, read_only=False):
            with original_db(root) as db:
                yield db

        run_ledger._db = old_read_lock
    try:
        return [await run_round(client, workers=workers, requests_per_round=requests_per_round)
                for _ in range(rounds)]
    finally:
        run_ledger._db = original_db


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workers', type=int, default=16)
    parser.add_argument('--requests-per-round', type=int, default=1600)
    parser.add_argument('--rounds', type=int, default=3)
    args = parser.parse_args()
    if min(args.workers, args.requests_per_round, args.rounds) < 1:
        parser.error('workers, requests-per-round and rounds must be positive')
    if args.requests_per_round % args.workers:
        parser.error('requests-per-round must be divisible by workers')

    with tempfile.TemporaryDirectory(prefix='easel-ledger-stress-') as temp:
        root = Path(temp) / 'ledger'
        run_ledger.accept(root, 'stress-turn', session_id='stress-session', session_key='stress-session')
        for index in range(20):
            run_ledger.mark(root, 'stress-turn', event='stress_fixture', index=index)
        web._run_ledger_root = lambda: root

        app = FastAPI()
        app.get('/api/chat/runs/{turn_id}/events')(web.api_chat_run_events)
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(('127.0.0.1', 0))
        listener.listen(256)
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, log_level='error', access_log=False))
        thread = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
        thread.start()
        deadline = time.monotonic() + 10
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        if not server.started:
            server.should_exit = True
            thread.join(timeout=5)
            raise RuntimeError('Isolated Uvicorn server did not start')

        async def benchmark() -> dict:
            limits = httpx.Limits(max_connections=args.workers, max_keepalive_connections=args.workers)
            async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}', limits=limits, timeout=10) as client:
                await run_round(client, workers=args.workers, requests_per_round=args.workers * 2)
                measurements: dict[str, list[dict]] = defaultdict(list)
                modes = ('begin_immediate_baseline', 'deferred_read')
                for round_index in range(args.rounds):
                    order = modes if round_index % 2 == 0 else tuple(reversed(modes))
                    for mode in order:
                        measurements[mode].extend(await run_mode(
                            client, mode=mode, workers=args.workers,
                            requests_per_round=args.requests_per_round, rounds=1))
            return {'baseline_BEGIN_IMMEDIATE': measurements['begin_immediate_baseline'],
                    'deferred_read': measurements['deferred_read']}

        try:
            results = asyncio.run(benchmark())
        finally:
            server.should_exit = True
            thread.join(timeout=10)
            listener.close()
            if thread.is_alive():
                raise RuntimeError('Isolated Uvicorn server did not stop')

    print(json.dumps({
        'environment': {'python': platform.python_version(), 'platform': platform.platform(),
                        'workers': args.workers, 'requests_per_round': args.requests_per_round,
                        'rounds': args.rounds, 'total_requests_per_mode': args.requests_per_round * args.rounds},
        'load': '16 HTTP readers plus one SQLite ledger writer targeting 50 writes/s per round',
        'results': results,
    }, indent=2))


if __name__ == '__main__':
    main()

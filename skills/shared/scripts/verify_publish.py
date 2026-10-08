#!/usr/bin/env python3
"""Read an existing creator work; this command has no upload/publish operation."""
from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import platform_readback as readback
import publish_receipt


def identify_work(works, *, title: str, since_ms: int, content_id: str = '', until_ms: int | None = None):
    """An existing ID never falls back to a different same-title work."""
    if content_id:
        matches = [item for item in works if item.platform_content_id == content_id]
    else:
        normalize = lambda value: ' '.join((value or '').split())
        wanted = normalize(title)
        latest = min(int(time.time() * 1000), until_ms) + 1000 if until_ms is not None else int(time.time() * 1000) + 1000
        matches = [item for item in works if wanted and normalize(item.title) == wanted
                   and type(item.published_at_ms) is int
                   and since_ms - 1000 <= item.published_at_ms <= latest]
    return matches[0] if len(matches) == 1 else None


def read_current_works(args):
    if args.platform == 'bilibili':
        if not Path(args.cookie).is_file():
            raise readback.LoginRequiredError('Missing Bilibili login')
        return readback.read_bilibili_works(args.cookie, limit=50)
    from playwright.sync_api import sync_playwright
    if args.platform == 'douyin':
        import douyin_publish as publisher
        profile = publisher._profile_dir(args.profile_base)
    else:
        import web_publisher as publisher
        profile = publisher._profile_dir('kuaishou', args.profile_base)
    if not profile.is_dir():
        raise readback.LoginRequiredError('Missing creator login profile')
    with sync_playwright() as playwright:
        if args.platform == 'douyin':
            browser = publisher._launch(playwright, args.headed, args.profile_base,
                                        publisher._proxy(args.proxy, args.no_proxy))
        else:
            browser = playwright.chromium.launch_persistent_context(
                str(profile), headless=not args.headed,
                args=publisher.LAUNCH_ARGS + ['--no-proxy-server'],
                viewport={'width': 1440, 'height': 900})
        try:
            page = browser.pages[0] if browser.pages else browser.new_page()
            page.set_default_timeout(20000)
            page.set_default_navigation_timeout(30000)
            if args.platform == 'douyin':
                page.goto(readback.DOUYIN_MANAGE_URL, wait_until='domcontentloaded')
                return readback.read_douyin_works(page, limit=50)
            return readback.read_kuaishou_works(page, limit=50)
        finally:
            browser.close()


def verify(args) -> dict:
    try:
        works = read_current_works(args)
        matched = identify_work(works, title=args.title, since_ms=args.since_ms,
                                content_id=args.content_id, until_ms=args.until_ms)
        result = readback.ReadbackResult(outcome='verified' if matched else 'unverified', matched=matched)
    except readback.LoginRequiredError:
        result = readback.ReadbackResult(outcome='login_required')
    except Exception:
        result = readback.ReadbackResult(outcome='readback_error')
    return publish_receipt.from_readback(args.platform, result)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', required=True, choices=['bilibili', 'douyin', 'kuaishou'])
    parser.add_argument('--title', required=True)
    parser.add_argument('--since-ms', type=int, required=True)
    parser.add_argument('--until-ms', type=int)
    parser.add_argument('--content-id', default='')
    parser.add_argument('--cookie', default='cookies.json')
    parser.add_argument('--profile-base')
    parser.add_argument('--headed', action='store_true')
    proxy = parser.add_mutually_exclusive_group()
    proxy.add_argument('--proxy')
    proxy.add_argument('--no-proxy', action='store_true')
    args = parser.parse_args(argv)
    if args.since_ms <= 0 or args.since_ms > int(time.time() * 1000) + 60000:
        parser.error('--since-ms must be a valid submission timestamp')
    if args.until_ms is not None and (args.until_ms < args.since_ms or args.until_ms > int(time.time() * 1000) + 60000):
        parser.error('--until-ms must bound the original submission window')
    if args.content_id and not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', args.content_id):
        parser.error('Invalid content ID')
    if not args.title.strip() and not args.content_id:
        parser.error('A title or existing content ID is required')
    receipt = publish_receipt.emit(verify(args))
    return 0 if receipt['outcome'] in {'published', 'submitted'} else 5


if __name__ == '__main__':
    raise SystemExit(main())

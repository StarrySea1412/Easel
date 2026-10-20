"""Bounded website references from tool receipts, without response bodies."""
import json
import re
from urllib.parse import urlsplit, urlunsplit, parse_qsl, unquote

WEB_TOOLS = re.compile(r'^(?:web_search|webSearch|web_fetch|easel_browser|browser(?:_\w+)?)$')
PRIVATE_QUERY = re.compile(r'token|password|secret|signature|credential|authorization|api[_-]?key|^key$|^sig$', re.I)


def safe_url(value):
    if not isinstance(value, str) or len(value) > 4000 or re.search(r'[\x00-\x20\x7f]', value):
        return None
    try:
        parts = urlsplit(value)
        if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
            return None
        if '[已隐藏]' in unquote(value) or '[REDACTED' in unquote(value):
            return None
        if any(PRIVATE_QUERY.search(key) for key, _ in parse_qsl(parts.query, keep_blank_values=True)):
            return None
        return urlunsplit((parts.scheme, parts.netloc, parts.path or '/', parts.query, ''))
    except ValueError:
        return None


def references(name, result, public):
    links, remaining = {}, 1200
    allow_text = bool(WEB_TOOLS.fullmatch(name))

    def add(value, title=''):
        url = safe_url(public(value))
        if url and len(links) < 100:
            links[url] = {'url': url, 'title': public(title)[:300] or links.get(url, {}).get('title', '')}

    def visit(value, depth=0, structured=False):
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 7:
            return
        if isinstance(value, list):
            for item in value[:100]:
                visit(item, depth + 1, structured)
        elif isinstance(value, dict):
            if allow_text or structured or value.get('type') == 'resource_link':
                add(value.get('url') or value.get('uri') or value.get('link'), value.get('title') or value.get('name', ''))
            for key in ('results', 'sources', 'citations', 'links', 'content', 'data', 'items', 'resources', 'structuredContent', 'resource', 'snapshot', 'tabs'):
                if key in value:
                    visit(value[key], depth + 1, structured or key == 'structuredContent' or value.get('type') == 'resource_link')
            if isinstance(value.get('text'), str) and allow_text:
                visit(value['text'], depth + 1)
        elif isinstance(value, str) and allow_text:
            text = value[:64000]
            try:
                visit(json.loads(text), depth + 1)
                return
            except (ValueError, RecursionError):
                pass
            text = public(text)
            pattern = r'\[([^\]\n]{1,300})\]\((https?://[^\s<>]+)\)'
            def markdown(match):
                add(match[2], match[1])
                return ''
            text = re.sub(pattern, markdown, text)
            for match in re.finditer(r'https?://[^\s<>"\]\[{}]+', text):
                add(match[0].rstrip('.,;:!?，。；：！？)）'))

    visit(result)
    return list(links.values())

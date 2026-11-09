"""Deterministic lexical ranking over an already scope-filtered memory pool."""
from collections import Counter
import math
import re
import unicodedata

ALGORITHM = 'bm25-nfkc-v1'


def tokens(text):
    text = unicodedata.normalize('NFKC', text).casefold()
    result = re.findall(r'[a-z0-9_]{2,}', text)
    for run in re.findall(r'[\u4e00-\u9fff]+', text):
        result.extend(run[index:index + 2] for index in range(len(run) - 1))
    return result


def rank(entries, query):
    """BM25 with bounded term saturation; no models, network, or persistent index.

    Callers must filter scope, source and literal conditions *before* ranking,
    so even corpus statistics cannot depend on another account's memories.
    Empty queries retain the previous deterministic id ordering.
    """
    entries = sorted(entries, key=lambda entry: entry['id'])
    query_terms = set(tokens(query))
    if not query.strip():
        return [(entry, 0.0, 0) for entry in entries]
    if not query_terms or not entries:
        return []
    documents = [Counter(tokens(entry['text'])) for entry in entries]
    lengths = [sum(document.values()) for document in documents]
    average = max(sum(lengths) / len(entries), 1)
    frequency = Counter(term for document in documents for term in query_terms & document.keys())
    rows = []
    for entry, document, length in zip(entries, documents, lengths):
        matches = query_terms & document.keys()
        if not matches:
            continue
        normalizer = 1.2 * (0.25 + 0.75 * length / average)
        score = sum(
            math.log1p((len(entries) - frequency[term] + 0.5) / (frequency[term] + 0.5))
            * document[term] * 2.2 / (document[term] + normalizer)
            for term in sorted(matches)
        )
        rows.append((entry, score, len(matches)))
    return sorted(rows, key=lambda row: (-row[1], row[0]['id']))

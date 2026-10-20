"""Bounded, content-free visual summaries of the existing project usage ledger."""
from datetime import datetime, timedelta, timezone

CHINA_TIME = timezone(timedelta(hours=8))


def dashboard(calls, summarize, now=None):
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(CHINA_TIME).date()
    dates = [(today - timedelta(days=29 - i)).isoformat() for i in range(30)]
    buckets = {day: [] for day in dates}
    dated, undated, future = [], 0, 0
    for call in calls:
        try:
            stamp = datetime.fromisoformat(call.get('timestamp', '').replace('Z', '+00:00'))
            stamp = stamp.replace(tzinfo=stamp.tzinfo or timezone.utc)
        except (ValueError, TypeError, AttributeError):
            undated += 1
            continue
        if stamp > now:
            future += 1
            continue
        dated.append((stamp, call))
        key = stamp.astimezone(CHINA_TIME).date().isoformat()
        if key in buckets:
            buckets[key].append(call)
    # A day without ledger events has zero recorded activity. A day with events
    # lacking token/cost fields keeps null through the normal summarizer.
    days = [{'date': key, 'summary': summarize(rows)} for key, rows in buckets.items()]
    dated.sort(key=lambda item: (item[0], item[1]['id']), reverse=True)
    recent_fields = ('id', 'sessionId', 'timestamp', 'model', 'provider', 'channelName',
                     'totalTokens', 'recordedCostUsd', 'engine')
    recent = [{key: call.get(key) for key in recent_fields} for _, call in dated[:20]]
    models = {}
    for call in calls:
        key = (call.get('channelId') or call.get('provider', ''), call.get('model', ''))
        models.setdefault(key, []).append(call)
    ranking = [{'channelId': channel, 'provider': rows[0].get('provider', ''),
                'channelName': rows[0].get('channelName') or rows[0].get('provider', ''),
                'model': model, 'summary': summarize(rows)}
               for (channel, model), rows in models.items()]
    ranking.sort(key=lambda item: (item['summary']['totalTokens'] or 0, item['summary']['calls']), reverse=True)
    return {'days': days, 'timezone': 'Asia/Shanghai', 'rangeDays': 30,
            'undatedCalls': undated, 'futureCalls': future,
            'recent': recent, 'recentLimit': 20,
            'models': ranking[:8], 'modelCount': len(ranking)}

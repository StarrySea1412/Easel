"""Reject metrics from obsolete, unscoped Douyin page collectors."""
from datetime import date


def verified_douyin_metrics(source):
    if not isinstance(source, dict) or source.get('schema') != 'douyin-account-overview-v2' \
            or source.get('section') != '账号总览' or source.get('period') != 'last_7_days' \
            or source.get('url') != 'https://creator.douyin.com/creator-micro/home':
        return False
    try:
        return (date.fromisoformat(source['to']) - date.fromisoformat(source['from'])).days == 6
    except (ValueError, TypeError, KeyError):
        return False


def sanitize_metrics(platform, data):
    if platform != 'douyin' or not isinstance(data, dict) or verified_douyin_metrics(data.get('metrics_source')):
        return data
    if not data.get('metrics') and not (isinstance(data.get('analysis'), dict) and data['analysis'].get('metrics')):
        return data
    result = {**data, 'metrics': [], 'metricsNeedsRefresh': True}
    if isinstance(data.get('analysis'), dict):
        from account_analysis import build_analysis
        result['analysis'] = build_analysis(platform, {key: value for key, value in result.items() if key != 'analysis'})
    return result

"""Ordinary schedule management with isolated data; no executor or model."""
import json

from easel.task_rules import GoalSpec
from easel.task_store import TaskStore


def plan(store):
    goal = GoalSpec(objective='隔离合成：整理已有素材清单', modelRef='fixture/model',
                    criteria=[{'type': 'review', 'label': '人工检查'}]).model_dump()
    return store.save_plan({'title': '隔离合成计划', 'enabled': False, 'goal': goal,
                            'schedule': {'kind': 'daily', 'timezone': 'Asia/Shanghai', 'time': '09:00'},
                            'missedPolicy': 'skip', 'freshnessSeconds': 900}, 2000)


def test_summary_counts_all_triggers_after_display_history_is_trimmed(tmp_path):
    store = TaskStore(tmp_path, clock=lambda: 1000)
    p = plan(store)
    for i in range(105):
        store.trigger_plan(p['id'], request=f'fixture-{i}')
    # A duplicate delivery is the same ordinary manual trigger.
    assert store.trigger_plan(p['id'], request='fixture-104') is None
    shown = store.snapshot()['plans'][0]
    assert len(shown['history']) == 100
    assert shown['triggerCount'] == shown['launchedCount'] == shown['activeCount'] == 105
    store.set_plan_enabled(p['id'], True, 1001)
    assert store.trigger_plan(p['id'], scheduled_at=1001, next_at=2000, missed=True) is None
    shown = TaskStore(tmp_path).snapshot()['plans'][0]
    assert shown['triggerCount'] == 106
    assert shown['launchedCount'] == shown['activeCount'] == 105
    assert shown['lastGoal'] is None
    assert shown['lastResult']['status'] == 'skipped'


def test_latest_result_is_read_even_when_goal_is_outside_management_window(tmp_path):
    store = TaskStore(tmp_path)
    p = plan(store)
    latest = store.trigger_plan(p['id'], request='first')
    store.change_goal(latest['id'], 'cancel')
    with store.db() as db:
        for i in range(305):
            fixture = {**latest, 'id': f'fixture-newer-{i}', 'sessionId': f'fixture-chat-{i}', 'status': 'completed', 'planId': None}
            db.execute('INSERT INTO goals VALUES(?,?,?,?)', (fixture['id'], fixture['sessionId'], 'completed', json.dumps(fixture)))
    shown = TaskStore(tmp_path).snapshot()
    assert latest['id'] not in {g['id'] for g in shown['goals']}
    summary = shown['plans'][0]
    assert summary['lastGoal']['id'] == latest['id']
    assert summary['lastGoal']['status'] == 'cancelled'
    assert summary['activeCount'] == 0
    edited = store.save_plan({**p, 'title': '改名后的隔离计划'}, 3000, p['id'])
    assert edited['history']
    assert store.snapshot()['plans'][0]['triggerCount'] == 1


def test_deleted_source_retains_counts_but_marks_result_link_unavailable(tmp_path):
    store = TaskStore(tmp_path)
    p = plan(store)
    latest = store.trigger_plan(p['id'], request='first')
    store.delete_session(latest['sessionId'])
    shown = store.snapshot()['plans'][0]
    assert shown['triggerCount'] == 1
    assert shown['lastGoal']['sessionDeleted'] is True

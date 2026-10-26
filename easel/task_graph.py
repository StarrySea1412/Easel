"""Dependency selection for the versioned parallel workflow, not model delegation."""
import hashlib

PARALLEL_WORKFLOW = 'parallel-reviewed-delivery'
PLANNED_WORKFLOW = 'planned-reviewed-delivery'


def parallel(goal):
    return goal.get('workflow') in (PARALLEL_WORKFLOW, PLANNED_WORKFLOW)


def ancestors(goal, stage_id):
    stages = {s['id']: s for s in goal['stages']}
    found, pending = set(), list(stages[stage_id].get('dependsOn', []))
    while pending:
        key = pending.pop()
        if key not in found:
            found.add(key)
            pending.extend(stages[key].get('dependsOn', []))
    return found


def ready_stages(goal):
    completed = {s['id'] for s in goal.get('stages', []) if s['status'] == 'completed'}
    return [s for s in goal.get('stages', []) if s['status'] in ('pending', 'blocked')
            and set(s.get('dependsOn', [])).issubset(completed)]


def admissible_stages(goal, live):
    ready = ready_stages(goal)
    if goal.get('workflow') != PLANNED_WORKFLOW:
        return ready
    running = {run['stageId'] for run in live}
    if any(stage.get('access') == 'write' and stage['id'] in running for stage in goal['stages']):
        return []
    return [stage for stage in ready if not live or stage.get('access') != 'write']


def affected_stages(goal, stage_id):
    if not parallel(goal):
        index = next(i for i, s in enumerate(goal['stages']) if s['id'] == stage_id)
        return goal['stages'][index:]
    return [s for s in goal['stages'] if s['id'] == stage_id or stage_id in ancestors(goal, s['id'])]


def worker_session(goal, stage):
    digest = hashlib.sha256((goal['id'] + ':' + stage['id']).encode()).hexdigest()[:48]
    return 'stage-' + digest

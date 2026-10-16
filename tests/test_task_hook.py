"""Run the actual native hook against temporary data; no model or real tool."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import pytest

from easel.task_store import TaskStore


def test_native_hook_uses_trusted_session_and_durable_tool_budget(tmp_path):
    root=Path(__file__).resolve().parents[1]
    hint=root/'.tools/node-dir.txt'
    node=Path(hint.read_text().strip())/'node.exe' if hint.is_file() else shutil.which('node')
    if not node or not Path(node).is_file():
        pytest.skip('Node runtime unavailable')
    store=TaskStore(tmp_path/'outputs')
    g=store.create_goal({'objective':'只读隔离目标','criteria':[{'type':'review','label':'质量','value':''}],
        'modelRef':'fixture/model','maxIterations':2,'maxSeconds':120,'maxTools':1,'maxImages':0},session='chat')
    store.change_goal(g['id'],'start');_,r=store.claim('worker')
    store.bind_provider('chat',r['turnId'],'native-run')
    source=f"""
    import {{registerTasks}} from {json.dumps((root/'openclaw/easel-agent-safety/tasks.mjs').as_uri())};
    let hook;let tool;
    registerTasks({{registerTool:value=>tool=value,on:(name,fn)=>hook=fn}});
    const first=await hook({{toolName:'read',runId:'native-run',toolCallId:'one'}},{{sessionKey:'agent:main:chat'}});
    const repeat=await hook({{toolName:'read',runId:'native-run',toolCallId:'one'}},{{sessionKey:'agent:main:chat'}});
    const other=await hook({{toolName:'exec',runId:'native-run',toolCallId:'two'}},{{sessionKey:'agent:main:chat'}});
    const normal=await hook({{toolName:'read',runId:'other',toolCallId:'one'}},{{sessionKey:'agent:main:ordinary-chat'}});
    console.log(JSON.stringify({{first:first??null,repeat:repeat??null,other,normal:normal??null,status:(await tool.execute()).details}}));
    """
    result=subprocess.run([str(node),'--input-type=module','-e',source],cwd=root,capture_output=True,text=True,encoding='utf-8',timeout=30,
        env={**os.environ,'EASEL_DATA_DIR':str(tmp_path),'EASEL_PYTHON':sys.executable})
    assert result.returncode==0,result.stderr
    receipt=json.loads(result.stdout)
    assert receipt['first'] is None and receipt['repeat'] is None and receipt['normal'] is None
    assert receipt['other']['block'] is True
    assert receipt['status']['version']==1
    assert store.get('goals',g['id'])['toolsUsed']==1

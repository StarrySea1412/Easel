from pathlib import Path
import os
import json
import subprocess
import sys
import pytest
from PIL import Image
from easel.artifacts import ArtifactStore
from easel.image_inspection import stage_owned_image

def prepared(tmp_path):
    outputs=tmp_path/'outputs';source=outputs/'topic/card.png';source.parent.mkdir(parents=True)
    Image.new('RGB',(8,8),'white').save(source)
    store=ArtifactStore(outputs);store.present('chat','turn',[{'path':str(source)}],source='test')
    return outputs,source,tmp_path/'state'

def test_staging_checks_exact_session_and_is_idempotent(tmp_path):
    outputs,source,state=prepared(tmp_path)
    target=stage_owned_image(outputs,state,'chat',str(source))
    assert target.read_bytes()==source.read_bytes()
    assert target.is_relative_to(state/'media/easel-attachments')
    assert stage_owned_image(outputs,state,'chat',str(source))==target
    with pytest.raises(ValueError,match='not delivered'):
        stage_owned_image(outputs,state,'other',str(source))

def test_unregistered_image_and_outside_paths_never_stage(tmp_path):
    outputs,source,state=prepared(tmp_path)
    other=source.with_name('unregistered.png');other.write_bytes(source.read_bytes())
    with pytest.raises(ValueError):stage_owned_image(outputs,state,'chat',str(other))
    outside=tmp_path/'outside.png';outside.write_bytes(source.read_bytes())
    with pytest.raises(ValueError):stage_owned_image(outputs,state,'chat',str(outside))
    assert not state.exists()

def test_invalid_or_oversized_content_never_stages(tmp_path):
    outputs,source,state=prepared(tmp_path)
    source.write_bytes(b'not an image')
    with pytest.raises((ValueError,OSError)):stage_owned_image(outputs,state,'chat',str(source))
    with source.open('wb') as handle:handle.truncate(20*1024*1024+1)
    with pytest.raises(ValueError,match='size limit'):stage_owned_image(outputs,state,'chat',str(source))
    assert not state.exists()

def test_runtime_hook_stages_delivered_image_before_native_tool(tmp_path):
    import shutil
    node=shutil.which('node')
    if not node:pytest.skip('node unavailable')
    outputs,source,state=prepared(tmp_path)
    root=Path(__file__).resolve().parents[1]
    module=(root/'openclaw/easel-agent-safety/runtime.mjs').as_uri()
    code="""import {runtimeToolParams} from MODULE;
const config={agents:{defaults:{imageModel:'visual/test'}},models:{providers:{visual:{models:[{id:'test',input:['text','image']}]}}}};
const event={toolName:'view_image',params:{path:process.argv[1]}};
const result=await runtimeToolParams(event,{sessionKey:'agent:main:chat'},config);
console.log(JSON.stringify(result));""".replace('MODULE',json.dumps(module))
    env={**os.environ,'EASEL_ROOT':str(root),'EASEL_DATA_DIR':str(outputs.parent),'EASEL_OPENCLAW_STATE_DIR':str(state),'EASEL_PYTHON':sys.executable}
    result=subprocess.run([node,'--input-type=module','-e',code,str(source)],capture_output=True,text=True,env=env,timeout=20)
    assert result.returncode==0,result.stderr
    value=json.loads(result.stdout)
    assert not value.get('block') and value['params']['model']=='visual/test'
    assert Path(value['params']['path']).read_bytes()==source.read_bytes()


def test_staging_rejects_symlinked_source_directory_inside_outputs(tmp_path):
    outputs,source,state=prepared(tmp_path)
    original=source.parent
    moved=outputs/'moved'
    original.rename(moved)
    try:
        original.symlink_to(moved,target_is_directory=True)
    except OSError:
        pytest.skip('symlink creation unavailable')
    with pytest.raises(ValueError,match='Untrusted'):
        stage_owned_image(outputs,state,'chat',str(source))
    assert not state.exists()

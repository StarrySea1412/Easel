"""No paid requests: exercise real queue, workers, delivery, image bytes and reviews."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace
import pytest
from PIL import Image, PngImagePlugin
from easel.artifacts import ArtifactStore, inspect_file
from easel.image_jobs import ImageJobs, ImageWorker
from easel.xhs_cards import XhsCards, CHECKS
from easel.task_store import TaskStore
from easel.task_rules import GoalSpec

CONFIG = {'IMG_BASE_URL':'https://fixture.invalid/v1','IMG_MODEL':'fixture-image','IMG_API_KEY':'fixture-not-a-real-key'}
ARGS = {'action':'submit','requestId':'set-one','style':'同一个黄色玩具，暖纸底色、自然光，中文短句',
        'prompts':['封面：桌上的玩具和标题','卖点：玩具细节与结构展示','收尾：书桌使用场景与收藏引导']}


def submit(root, args=None, turn='turn'):
    return XhsCards(root).execute(args or ARGS, CONFIG, session='chat',turn=turn)


def render(root, colors=('red','green','blue'), size=(768,1024)):
    calls=[]
    def provider(cmd, **kwargs):
        color=colors[len(calls)];calls.append(cmd)
        meta=PngImagePlugin.PngInfo();meta.add_text('fixture',str(len(calls)))
        Image.new('RGB',size,color).save(cmd[cmd.index('--output')+1], pnginfo=meta)
        return SimpleNamespace(returncode=0)
    jobs=ImageJobs(root)
    worker=ImageWorker(Path(__file__).resolve().parents[1],lambda:root,lambda:CONFIG,lambda:{},runner=provider)
    for _ in range(3):
        claim=jobs.claim(CONFIG,worker.owner)
        assert claim
        worker.run(jobs,claim,CONFIG)
    return calls


def review(result):
    return {'action':'review','requestId':ARGS['requestId'],'reviews':[
        {'sha256':c['sha256'],'evidence':'合成测试审图记录：本张为不同颜色的测试图片，不是真实商品验收',**dict.fromkeys(CHECKS,True)} for c in result['cards']]}


def test_atomic_three_distinct_jobs_parallel_idempotency_and_configless_status(tmp_path):
    with ThreadPoolExecutor(5) as pool:
        results=list(pool.map(lambda _:submit(tmp_path),range(10)))
    assert len({r['cardSetId'] for r in results})==1
    jobs=ImageJobs(tmp_path).list('chat')
    assert len(jobs)==3 and all(j['n']==1 and j['size']=='768x1024' for j in jobs)
    assert {j['cardRole'] for j in jobs}=={'cover','content','ending'}
    assert len({j['prompt'] for j in jobs})==3
    assert not results[0]['complete'] and results[0]['ready']==0
    status={'action':'status','requestId':'set-one'}
    assert XhsCards(tmp_path).execute(status,{},session='chat',turn='turn')['ready']==0
    with pytest.raises(FileNotFoundError):
        XhsCards(tmp_path).execute(status,{},session='foreign',turn='turn')
    with pytest.raises(ValueError,match='不同参数'):
        submit(tmp_path,{**ARGS,'style':'其他风格'})
    assert len(ImageJobs(tmp_path).list('chat'))==3


@pytest.mark.parametrize('patch',[{'prompts':['one','two']},{'prompts':['same']*3},{'style':''},{'requestId':'../escape'},{'prompts':['one','two',None]}])
def test_invalid_plan_never_partially_submits(tmp_path,patch):
    with pytest.raises(ValueError):submit(tmp_path,{**ARGS,**patch})
    assert not ImageJobs(tmp_path).list('chat')


def test_budget_reserves_all_three_or_none_and_cancel_fences_new_plan(tmp_path):
    store=TaskStore(tmp_path)
    g=store.create_goal(GoalSpec(objective='制作三图卡组',modelRef='fixture/model',criteria=[{'type':'review','label':'质量'}],maxImages=2).model_dump(),session='chat')
    store.change_goal(g['id'],'start');g,run=store.claim('owner');turn=run['turnId']
    with pytest.raises(ValueError,match='数量上限'):submit(tmp_path,turn=turn)
    assert not ImageJobs(tmp_path).list('chat')
    assert store.get('goals',g['id'])['imagesUsed']==0
    ImageJobs(tmp_path).cancel_turn('chat','turn')
    with pytest.raises(ValueError,match='已停止'):submit(tmp_path)
    assert not ImageJobs(tmp_path).list('chat')


def test_actual_three_files_need_review_current_hashes_and_no_regeneration(tmp_path):
    result=submit(tmp_path)
    assert len(render(tmp_path))==3
    result=XhsCards(tmp_path).get('chat','turn',result['cardSetId'])
    assert result['ready']==3 and not result['complete'] and result['qualityState']=='pending'
    assert len(ArtifactStore(tmp_path).snapshot('chat')['artifacts'])==3
    bad=review(result);bad['reviews'][1]['readableText']=False
    with pytest.raises(ValueError,match='未通过'):
        XhsCards(tmp_path).execute(bad,{},session='chat',turn='turn')
    checked=XhsCards(tmp_path).execute(review(result),{},session='chat',turn='turn')
    assert checked['complete'] and checked['qualityState']=='assistant_reviewed'
    # A changed file revokes approval even if the old receipt still says done.
    path=tmp_path/result['cards'][0]['path'];Image.new('RGB',(768,1024),'yellow').save(path)
    changed=XhsCards(tmp_path).get('chat','turn',result['cardSetId'])
    assert changed['ready']==2 and not changed['complete']
    assert len(ImageJobs(tmp_path).list('chat'))==3


@pytest.mark.parametrize('colors,size,ready',[(('red','red','blue'),(768,1024),2),(('red','green','blue'),(200,300),0),(('red','green','blue'),(1024,1024),0)])
def test_duplicate_pixels_different_metadata_or_wrong_dimensions_never_complete(tmp_path,colors,size,ready):
    plan=submit(tmp_path);render(tmp_path,colors,size)
    result=XhsCards(tmp_path).get('chat','turn',plan['cardSetId'])
    assert result['ready']==ready and not result['complete']
    with pytest.raises(ValueError):XhsCards(tmp_path).execute({'action':'review','requestId':'set-one','reviews':[]},{},session='chat',turn='turn')


@pytest.mark.parametrize('damage',['missing','corrupt','outside','not-delivered'])
def test_missing_corrupt_foreign_or_unpresented_image_blocks_completion(tmp_path,damage):
    plan=submit(tmp_path);render(tmp_path)
    jobs=ImageJobs(tmp_path)
    job=jobs.list('chat')[0]
    path=tmp_path/job['paths'][0]
    if damage=='missing':path.unlink()
    elif damage=='corrupt':path.write_bytes(b'invalid image')
    else:
        with jobs.db() as db:
            row=db.execute('SELECT data FROM jobs WHERE id=?',(job['jobId'],)).fetchone();data=json.loads(row[0])
            if damage=='outside':data['paths']=['../outside.png']
            else:data['artifactIds']=[]
            db.execute('UPDATE jobs SET data=? WHERE id=?',(json.dumps(data),job['jobId']))
    result=XhsCards(tmp_path).get('chat','turn',plan['cardSetId'])
    assert result['ready']==2 and not result['complete']


def test_real_openclaw_tool_enqueues_once_and_checks_ticket_scope(tmp_path):
    node=shutil.which('node')
    if not node:pytest.skip('Node unavailable')
    (tmp_path/'.env').write_text('\n'.join(f'{k}={v}' for k,v in CONFIG.items()),encoding='utf-8')
    root=tmp_path/'outputs';ticket=ArtifactStore(root).bind('chat','turn')
    module=Path(__file__).resolve().parents[1]/'openclaw/easel-agent-safety/xhs-cards.mjs'
    program="""import {registerXhsCards} from MODULE;
let factory;registerXhsCards({registerTool:v=>{factory=v}});
const tool=factory({sessionKey:'agent:main:chat'}),args=ARGS;
const first=await tool.execute('a',args),again=await tool.execute('b',args);
if(first.details.job.cardSetId!==again.details.job.cardSetId)throw new Error('duplicate');
let refused=false;try{await factory({sessionKey:'agent:main:foreign'}).execute('c',args)}catch{refused=true}
if(!refused)throw new Error('foreign accepted');
console.log(JSON.stringify(first.details));""".replace('MODULE',json.dumps(module.as_uri())).replace('ARGS',json.dumps({**ARGS,'ticket':ticket}))
    result=subprocess.run([node,'--input-type=module'],input=program,text=True,encoding='utf-8',capture_output=True,
        env={**os.environ,'EASEL_DATA_DIR':str(tmp_path),'EASEL_CODE_ROOT':str(module.parents[2]),'EASEL_PYTHON':sys.executable},timeout=40)
    assert result.returncode==0,result.stderr
    assert len(ImageJobs(root).list('chat'))==3


def test_codex_runtime_uses_same_batch_and_receipt(tmp_path,monkeypatch):
    from easel.codex_service import CodexService
    from easel import codex_service
    monkeypatch.setattr(codex_service,'read_config',lambda _:CONFIG)
    service=CodexService.__new__(CodexService);service.outputs=tmp_path
    replies=[];service._reply=lambda run,ident,result:replies.append(result);service._event=lambda *a:None
    run={'state':{'sessionId':'chat','turn_id':'turn'}}
    event={'id':1,'method':'item/tool/call','params':{'tool':'easel_xhs_cards','arguments':ARGS}}
    assert service._request(run,event) is False
    assert replies[0]['success'] and len(ImageJobs(tmp_path).list('chat'))==3


def test_pending_card_review_prevents_automatic_goal_completion(tmp_path):
    store=TaskStore(tmp_path)
    goal=store.create_goal(GoalSpec(objective='制作三图',modelRef='fixture/model',criteria=[{'type':'file','label':'图片','value':'card.png'}],maxImages=3).model_dump(),session='chat')
    store.change_goal(goal['id'],'start');goal,run=store.claim('owner')
    first=submit(tmp_path,turn=run['turnId']);submit(tmp_path,turn=run['turnId'])
    assert store.get('goals',goal['id'])['imagesUsed']==3
    checks=[{**c,'state':'passed'} for c in goal['criteria']]
    settled=store.finish(run['id'],owner='owner',checks=checks,quality_pending=first['label'])
    assert settled['status']=='blocked' and settled['phase']=='review'
    assert '三图质量验收' in settled['reason']


def test_shared_product_reference_reaches_all_three_image_edits(tmp_path):
    from web.image_inputs import store_reference
    import io
    data=io.BytesIO();Image.new('RGB',(48,64),'yellow').save(data,format='PNG')
    reference=store_reference(tmp_path/'_image_references',data.getvalue(),'toy.png')
    result=submit(tmp_path,{**ARGS,'referenceId':reference['id']})
    jobs=ImageJobs(tmp_path).list('chat')
    assert len(jobs)==3 and all(j['mode']=='img2img' and j['referenceId']==reference['id'] for j in jobs)
    with pytest.raises(ValueError):submit(tmp_path,{**ARGS,'requestId':'other','referenceId':'../escape'})
    assert len(ImageJobs(tmp_path).list('chat'))==3

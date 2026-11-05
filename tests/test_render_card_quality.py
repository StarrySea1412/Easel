"""Real Chromium media/overflow gates, no model or provider requests."""
import asyncio
import importlib.util
import os
from pathlib import Path
import shutil
from types import SimpleNamespace
import pytest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('render_card',ROOT/'skills/shared/scripts/render_card.py')
renderer=importlib.util.module_from_spec(spec);spec.loader.exec_module(renderer)

@pytest.mark.parametrize('html,expected',[
 ('<img src="missing-product.png" width="200" height="150">','未加载的图片'),
 ('<div style="height:500px">Too tall</div>','溢出或裁切'),
 ('<div style="height:50px;overflow:hidden"><div style="height:100px">Clipped</div></div>','溢出或裁切'),
 ('<h1 style="font-size:82px;line-height:1.22;margin:0">正常标题</h1>',None),
 ('<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=" width="100" height="100">',None),
])
def test_actual_browser_rejects_broken_media_and_overflow(html,expected):
 async def run():
  from playwright.async_api import async_playwright
  async with async_playwright() as p:
   candidates=[os.environ.get('EASEL_TEST_CHROMIUM'),shutil.which('chromium'),r'C:\Program Files\Google\Chrome\Application\chrome.exe',r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe']
   executable=next((v for v in candidates if v and Path(v).is_file()),None)
   try:browser=await p.chromium.launch(**({'executable_path':executable} if executable else {}),headless=True,args=['--no-sandbox'])
   except Exception:pytest.skip('Chromium unavailable')
   try:
    page=await browser.new_page(viewport={'width':400,'height':300})
    await page.set_content('<style>.card{width:400px;height:300px;overflow:hidden}</style><div class="card">'+html+'</div>')
    issues=await renderer._validate_page(page,SimpleNamespace(all='.card',selector=None,full_page=False))
    if expected:assert any(expected in issue for issue in issues),issues
    else:assert issues==[]
   finally:await browser.close()
 asyncio.run(run())

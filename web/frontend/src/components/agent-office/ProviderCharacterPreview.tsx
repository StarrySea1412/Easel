import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createProviderStudyCharacter, type ProviderStudyId, type ProviderStudyPose } from './providerCharacterGeometry';
import './provider-character-preview.css';

const STUDIES: { id: ProviderStudyId; name: string; hint: string; color: string }[] = [
  { id: 'doubao', name: '豆包', hint: '侧分短棕发 · 黑衣白领 · 人物比例', color: '#906951' },
  { id: 'deepseek', name: 'DeepSeek', hint: '蓝鲸轮廓 · 浅色腹部 · 鲸尾识别', color: '#397feb' },
  { id: 'unknown', name: '来源未确认', hint: '石墨机身 · 中性面罩 · 短天线', color: '#65707e' },
];

export function ProviderCharacterPreview({ onClose }: { onClose?: () => void }) {
  const [provider, setProvider] = useState<ProviderStudyId>('doubao');
  const [pose, setPose] = useState<ProviderStudyPose>('standing');
  const [view, setView] = useState<'three-quarter' | 'front' | 'side' | 'back'>('three-quarter');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const downloadReference = useRef<(() => void) | null>(null);
  const current = STUDIES.find((item) => item.id === provider)!;
  useEffect(() => {
    if (!host.current) return;
    const element = host.current;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { setError('此设备暂时无法打开 3D 预览，请启用浏览器硬件加速后重试。'); return; }
    setError('');
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    renderer.domElement.setAttribute('aria-label', `${current.name} ${pose === 'standing' ? '站姿' : '办公坐姿'} 3D 审核样例`);
    renderer.domElement.setAttribute('role', 'img');
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, .1, 30);
    const viewpoints = { 'three-quarter': [3.2, 2.6, 6.4], front: [0, 1.8, 7.2], side: [7.2, 1.8, 0], back: [0, 1.8, -7.2] };
    camera.position.set(...viewpoints[view] as [number, number, number]);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.3, 0); controls.enableDamping = true; controls.enablePan = false;
    controls.minDistance = 3.8; controls.maxDistance = 10; controls.maxPolarAngle = Math.PI * .49;
    scene.add(new THREE.HemisphereLight('#e4f0ff', '#b5a895', 1.8));
    const key = new THREE.DirectionalLight('#fff1dd', 3); key.position.set(-3, 6, 4); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -4; key.shadow.camera.right = 4;
    key.shadow.camera.top = 5; key.shadow.camera.bottom = -3; key.shadow.bias = -.001; scene.add(key);
    const rim = new THREE.DirectionalLight('#a8caff', 2); rim.position.set(3, 3, -4); scene.add(rim);
    const model = createProviderStudyCharacter(provider, pose); scene.add(model);
    const stage = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.55, .12, 64), new THREE.MeshStandardMaterial({ color: '#e8e4db', roughness: .8 }));
    stage.position.y = -.07; stage.receiveShadow = true; scene.add(stage);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: .12 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -.135; ground.receiveShadow = true; scene.add(ground);
    if (pose === 'seated') {
      const furniture = new THREE.MeshStandardMaterial({ color: '#b0b6b8', roughness: .85 });
      const tabletop = new THREE.MeshStandardMaterial({ color: '#e2d5c0', roughness: .85 });
      const box = (x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material) => {
        const part = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); part.position.set(x, y, z); part.castShadow = true; part.receiveShadow = true; scene.add(part);
      };
      box(0, .51, -.03, .78, .09, .66, furniture); box(0, .91, -.34, .75, .77, .08, furniture);
      for (const x of [-.3, .3]) for (const z of [-.28, .20]) box(x, .25, z, .05, .5, .05, furniture);
      box(0, .97, .87, 1.5, .08, .7, tabletop);
      for (const x of [-.64, .64]) box(x, .46, 1.05, .06, .92, .06, furniture);
      box(0, 1.025, .68, .76, .025, .24, furniture);
      box(0, 1.10, 1.07, .08, .2, .06, furniture);
      box(0, 1.34, 1.08, .8, .47, .055, furniture);
      box(0, 1.34, 1.045, .74, .40, .012, new THREE.MeshStandardMaterial({ color: '#273b4c', roughness: .6 }));
    }
    downloadReference.current = () => {
      const environment = scene.children.filter((object) => object instanceof THREE.Mesh);
      const visibility = environment.map((object) => object.visible);
      const background = scene.background;
      try {
        environment.forEach((object) => { object.visible = false; });
        scene.background = new THREE.Color('#ffffff');
        // toBlob snapshots synchronously; restoring the preview cannot alter that snapshot.
        renderer.render(scene, camera);
        renderer.domElement.toBlob((blob) => {
          if (!blob) { setError('参考图导出失败，请重新加载后重试。'); return; }
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          try {
            link.href = url; link.download = `easel-${provider}-${pose}-reference.png`;
            document.body.appendChild(link); link.click();
          } finally {
            link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          }
        }, 'image/png');
      } catch {
        setError('参考图导出失败，请重新加载后重试。');
      } finally {
        environment.forEach((object, index) => { object.visible = visibility[index]; });
        scene.background = background;
        renderer.render(scene, camera);
      }
    };
    let frame = 0, disposed = false;
    const resize = () => { const w = element.clientWidth, h = element.clientHeight; if (!w || !h) return; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const contextLost = (event: Event) => { event.preventDefault(); cancelAnimationFrame(frame); setError('3D 显示连接已中断，请点击重新加载。'); };
    renderer.domElement.addEventListener('webglcontextlost', contextLost);
    const render = () => { if (disposed) return; controls.update(); renderer.render(scene, camera); frame = requestAnimationFrame(render); }; render();
    return () => {
      downloadReference.current = null; disposed = true; cancelAnimationFrame(frame); observer.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      const materials = new Set<THREE.Material>();
      scene.traverse((object) => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material); } });
      materials.forEach((material) => material.dispose()); renderer.dispose(); renderer.domElement.remove();
    };
  }, [provider, pose, view, current.name, revision]);
  return <section className="provider-study" aria-label="模型厂商 3D 形象审核">
    <header className="provider-study__header"><div><span className="provider-study__eyebrow">CHARACTER LAB / 01</span><h2>让模型，有自己的模样。</h2><p>先审轮廓，再进办公室。首批三款可旋转 3D 研究样例。</p></div>{onClose && <button type="button" onClick={onClose}>返回工作室 ↗</button>}</header>
    <div className="provider-study__layout"><div className="provider-study__canvas-wrap"><div ref={host} className="provider-study__canvas" /><span className="provider-study__watermark">待审核 · 程序建模样例</span><div className="provider-study__caption"><strong>{current.name}</strong><span>{pose === 'standing' ? '01 / 站姿轮廓' : '02 / 办公坐姿'}</span></div><span className="provider-study__gesture">拖动旋转 · 滚轮缩放</span>{error && <div className="provider-study__error" role="status"><p>{error}</p><button type="button" onClick={() => setRevision((value) => value + 1)}>重新加载</button></div>}</div>
    <aside className="provider-study__panel"><span className="provider-study__eyebrow">IDENTITY / 形象方向</span><div className="provider-study__choices">{STUDIES.map((item) => <button type="button" key={item.id} aria-pressed={provider === item.id} onClick={() => setProvider(item.id)}><i style={{ background: item.color }} /><span><strong>{item.name}</strong><small>{item.hint}</small></span><span aria-hidden="true">↗</span></button>)}</div>
    <fieldset><legend>检查姿态</legend><div className="provider-study__poses"><button type="button" aria-pressed={pose === 'standing'} onClick={() => setPose('standing')}>站姿</button><button type="button" aria-pressed={pose === 'seated'} onClick={() => setPose('seated')}>办公坐姿</button></div></fieldset>
    <fieldset><legend>检查角度</legend><div className="provider-study__poses">{([['three-quarter', '透视'], ['front', '正面'], ['side', '侧面'], ['back', '背面']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}</div></fieldset>
    <button className="provider-study__download" type="button" disabled={Boolean(error)} onClick={() => downloadReference.current?.()}>下载角色参考图 ↓</button><p className="provider-study__download-note">PNG · 白底纯角色 · 不含台座、地面和桌椅。图生 3D 建议用站姿。</p><div className="provider-study__note"><h3>这轮看什么</h3><p>识别头部轮廓、侧面比例和桌后辨识度。豆包延续短棕发人物，DeepSeek 延续蓝鲸，未知来源保持中性。</p><p>本页为本地程序建模，不是 AI 生成结果；未替换正式角色，也不表示真实模型正在工作。其余 12 款仍待制作。</p></div>
    <div className="provider-study__scope"><span>审核后继续</span><p>确认风格 → 生成 / 精修模型 → 骨骼与接触点 → 实际调用身份</p></div></aside></div>
  </section>;
}
export default ProviderCharacterPreview;

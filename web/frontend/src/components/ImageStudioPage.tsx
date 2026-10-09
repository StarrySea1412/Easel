import { NativeSelect as Select } from './ui/Select';
import RadioGroup from './ui/RadioGroup';
import InpaintMaskEditor from './InpaintMaskEditor';
import { useEffect, useRef, useState } from 'react';
import AspectRatioIcon from './AspectRatioIcon';
import { IMAGE_SIZES } from '../hooks/useImageStudio';
import type { ImageStudioController } from '../hooks/useImageStudio';
import type { VideoStudioController } from '../hooks/useVideoStudio';
import ImageReversePanel from './ImageReversePanel';
import VideoStudioPanel from './VideoStudioPanel';
import StudioMediaSource from './StudioMediaSource';
import StudioModelControl from './StudioModelControl';
import { useStudioMediaInput } from '../hooks/useStudioMediaInput';
import { firstStudioMedia, STUDIO_MEDIA_ACCEPT } from '../lib/studioClipboard';
import { IconOutputs } from './icons';
import { IconGear, IconImage } from './settingsIcons';
import '../styles/image-studio.css';

const EXAMPLES = [
  ['产品摄影', '一杯咖啡放在窗边，清晨柔光，奶白色背景，产品摄影'],
  ['封面插画', '秋日城市漫步，银杏与街角咖啡店，暖色手绘封面插画'],
  ['场景概念', '未来植物温室，透明玻璃与绿色植被，电影感光影'],
];
const EDIT_EXAMPLES = [
  ['换背景', '保留主体，把背景换成干净的奶白色，添加自然柔和的阴影。'],
  ['调整光线', '保留构图和主体，把光线调整为温暖的傍晚阳光。'],
  ['转为插画', '保留主体和构图，改成细腻的手绘插画风格。'],
];

export default function ImageStudioPage({ studio, video, onOpenSettings, onOpenOutputs, onOpenModels, onOpenVideoSettings }: {
  studio: ImageStudioController; onOpenSettings: () => void; onOpenOutputs: () => void; onOpenModels: () => void;
  video?: VideoStudioController; onOpenVideoSettings?: () => void;
}) {
  const uploadInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [maskEditorReference,setMaskEditorReference]=useState<string|null>(null);
  const [previewChoice, setPreviewChoice] = useState({ scope: '', original: false });
  const returnMode = useRef<'generate' | 'img2img'>(studio.mode === 'img2img' ? 'img2img' : 'generate');
  const busy = studio.imgSubmitting || studio.imgJob?.state === 'running';
  const media = useStudioMediaInput(studio.uploadReference, busy || studio.referenceBusy || studio.modelSaving, studio.reference?.id ?? null);
  const locked = busy || studio.referenceBusy || studio.modelSaving || media.processing;
  const editing = studio.mode === 'img2img';
  const reference = editing ? studio.reference : null;
  const job = studio.imgJob;
  // Do not present a previous result as an edit of a newly uploaded image.
  const belongsToDraft = editing ? Boolean(reference && job?.mode === 'img2img' && job.referenceId === reference.id) : job?.mode !== 'img2img';
  const result = belongsToDraft && job?.state === 'done' ? job.url : null;
  const actual = result && job?.width && job?.height ? { width: job.width, height: job.height } : null;
  const previewScope = `${reference?.id || 'text'}:${job?.jobId || ''}`;
  const original = Boolean(reference && (!result || (previewChoice.scope === previewScope && previewChoice.original)));
  const previewUrl = original ? reference?.url : result;
  const sizeId = (result || busy) && job && !studio.imgSubmitting ? job.size : studio.imgSize;
  const size = IMAGE_SIZES.find(item => item.id === sizeId) || IMAGE_SIZES[0];
  const [width, height] = size.id.split('x').map(Number);
  const ratioMismatch = size.id !== 'auto' && actual && Math.abs(actual.width / actual.height - width / height) > .01;
  const canGenerate = !locked && !studio.loading && !studio.galleryError && studio.imgChannel?.configured
    && typeof studio.imgChannel.model === 'string' && studio.imgChannel.model.trim() && (!editing || reference)
    && studio.imgPrompt.trim().length > 0 && studio.imgPrompt.trim().length <= 2000;
  const receiveFile = (file?: File) => { if (file && !locked) void media.receiveFile(file); };
  const videoMode = video?.viewMode === 'video';
  const openVideoSettings = onOpenVideoSettings || onOpenModels;
  const maskScope=reference?`${reference.id}:${reference.url}:${reference.width}:${reference.height}`:null;
  useEffect(()=>setMaskEditorReference(null),[maskScope,videoMode]);

  return <div className="page-scroll image-page">
    <header className="image-page-heading">
      <div><p className="image-eyebrow">EASEL / IMAGE STUDIO</p><h1 className="page-title">生图工坊</h1><p className="page-subtitle">描述一个想法，创作图片或视频。</p></div>
      <div className="image-heading-actions" role="group" aria-label="生图工坊快捷入口">
        <button type="button" className="btn image-heading-action" onClick={onOpenOutputs}><IconOutputs size={17} />作品</button>
        <button type="button" className="btn image-heading-action" aria-label={videoMode ? '视频通道设置' : '生图通道设置'} onClick={videoMode ? openVideoSettings : onOpenSettings}><IconGear size={17} /><span>设置</span></button>
      </div>
    </header>
    {video && <div className="studio-medium-switch">
      <RadioGroup aria-label="创作类型" value={videoMode?'video':'image'} onChange={video.setViewMode} options={[
        {value:'image',ariaLabel:'图片',label:<>图片{busy&&<span className="studio-running-dot" style={{background:'currentColor'}} title="图片生成中" aria-label="图片生成中"/>}</>},
        {value:'video',ariaLabel:'视频',label:<>视频{video.busy&&<span className="studio-running-dot" style={{background:'currentColor'}} title="视频生成中" aria-label="视频生成中"/>}</>},
      ]}/>
      <span>草稿和任务分别保留</span>
    </div>}
    {videoMode && video ? <VideoStudioPanel video={video} images={studio.gallery} onOpenSettings={openVideoSettings} /> : <>
    <div className="image-local-toolbar">
      <span>{studio.mode === 'reverse' ? '从图片提取提示词' : reference ? '修改图片' : '图片创作'}</span>
      {studio.mode === 'reverse'
        ? <button className="link-btn" disabled={studio.reverse.busy} onClick={() => studio.setMode(returnMode.current)}>← 返回图片创作</button>
        : <button className="link-btn" disabled={locked} onClick={() => { returnMode.current = studio.mode === 'img2img' ? 'img2img' : 'generate'; studio.setMode('reverse'); }}>提取提示词 ↗</button>}
    </div>
    {studio.mode === 'reverse' ? <ImageReversePanel studio={studio} onOpenSettings={onOpenSettings} /> : <>
      <StudioModelControl model={(busy && job?.model) || studio.imgChannel?.model || ''} service="当前图片模型" disabled={locked || studio.loading} saving={studio.modelSaving} error={studio.modelError} onSave={studio.saveModel} onSettings={onOpenSettings} />
      <section className={`image-creation${dragging ? ' is-dragging' : ''}`} aria-label="图片创作工作区"
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); if (!locked) setDragging(true); } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={event => { event.preventDefault(); setDragging(false); receiveFile(event.dataTransfer.files[0]); }}
        onPaste={event => { const file = firstStudioMedia(event.clipboardData.files); if (file) { event.preventDefault(); receiveFile(file); } }}>
        <div className="image-canvas-toolbar">
          <span>{reference ? original ? '原图' : '生成结果' : result ? '生成结果' : '画布'}{original && reference ? <small>{reference.width} × {reference.height}</small> : actual ? <small>{actual.width} × {actual.height}</small> : null}</span>
          {reference && <><button type="button" className="link-btn" disabled={locked} onClick={()=>setMaskEditorReference(maskScope)}>涂抹修改区域</button><button type="button" className="link-btn" disabled={locked} onClick={studio.clearReference}>移除图片</button></>}
          {result && reference && <div className="image-compare" role="group" aria-label="原图与结果对比">
            <button disabled={locked} aria-pressed={original} onClick={() => setPreviewChoice({ scope: previewScope, original: true })}>原图</button>
            <button disabled={locked} aria-pressed={!original} onClick={() => setPreviewChoice({ scope: previewScope, original: false })}>结果</button>
          </div>}
          {result && <div className="image-result-actions"><a href={result} target="_blank" rel="noreferrer">打开图片 ↗</a><a href={result} download>下载</a>
            <button className="link-btn" disabled={locked} onClick={() => void studio.useGalleryReference({ url: result, name: result.split('/').at(-1) || '生成图片.png', mtime: Date.now() / 1000, width: actual?.width, height: actual?.height })}>继续修改</button>
          </div>}
          {video && (previewUrl || result) && <button type="button" className="link-btn" disabled={locked || video.locked} onClick={() => {
            if (original && reference) video.useReference(reference);
            else if (result) void video.useGalleryReference({ url: result, name: result.split('/').at(-1) || '生成图片.png', mtime: Date.now() / 1000 });
          }}>用这张图生成视频 →</button>}
        </div>
        <div className={`image-canvas${busy ? ' is-busy' : ''}`} aria-label="图片画布">
          {previewUrl ? <img className="image-canvas-picture" src={previewUrl} alt={original ? `原图：${reference!.name}` : job?.prompt || '生成结果'} />
            : !busy && <div className="image-canvas-empty"><span className="image-empty-symbol"><IconImage size={30} /></span>
              <h2>{media.processing ? '正在读取参考素材…' : studio.referenceBusy ? '正在放入图片…' : '从一张图片，或一个想法开始'}</h2><p>拖入或粘贴图片，描述你想改什么。<br />也可以直接在下方写下想法，生成新图片。</p>
              <button className="btn" disabled={locked} onClick={() => uploadInput.current?.click()}>选择图片或视频</button><small>图片最大 10 MB · 视频提取首帧</small>
            </div>}
          {busy && <div className="image-progress" role="status"><span className="image-progress-spinner" aria-hidden="true" /><strong>{studio.imgSubmitting ? '正在提交…' : `正在生成 · 已等待 ${studio.imgTick} 秒`}</strong><p>可以离开此页，回来继续查看。</p></div>}
          {dragging && <div className="image-drop-overlay">松开放入图片</div>}
        </div>
        <form className="image-composer" onSubmit={event => { event.preventDefault(); if (canGenerate) void studio.fireImagegen(); }}>
          <label className="image-prompt-label" htmlFor="image-prompt">{reference ? '这张图，你想怎么改？' : '你想生成什么？'}</label>
          <textarea id="image-prompt" rows={2} value={studio.imgPrompt} placeholder={reference ? '例如：保留这只猫，把背景换成阳光下的咖啡馆。' : '例如：窗边的一杯咖啡，清晨柔光，胶片摄影质感。'}
            onChange={event => studio.setImgPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); if (canGenerate) void studio.fireImagegen(); } }} />
          {!studio.imgPrompt && <div className="image-prompt-suggestions">{(reference ? EDIT_EXAMPLES : EXAMPLES).map(([label, prompt]) => <button type="button" key={label} disabled={locked} onClick={() => studio.setImgPrompt(prompt)}>{label}</button>)}</div>}
          <div className="image-composer-toolbar"><div className="image-composer-tools">
            <button type="button" className="btn image-add-reference" disabled={locked} onClick={() => uploadInput.current?.click()}><IconImage size={16} />{studio.referenceBusy ? '上传中…' : reference ? '换图' : '添加图片'}</button>
            <button type="button" className="btn image-add-reference" disabled={locked} onClick={() => void media.pasteClipboard()}>{media.processing ? '读取素材中…' : '从剪贴板粘贴'}</button>
            <input ref={uploadInput} aria-label="上传参考图" type="file" hidden accept={STUDIO_MEDIA_ACCEPT} disabled={locked} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; receiveFile(file); }} />
            <label className="image-ratio-select"><span>比例</span><Select aria-label="画面比例" optionIcons={Object.fromEntries(IMAGE_SIZES.map(item => [item.id, <AspectRatioIcon key={item.id} ratio={item.ratio} automatic={item.id === 'auto'}/>]))} disabled={locked} value={studio.imgSize} onChange={event => studio.setImgSize(event.target.value)}>{IMAGE_SIZES.map(item => <option key={item.id} value={item.id}>{item.id === 'auto' ? '自动尺寸' : item.label.split(' ').at(-1)}</option>)}</Select></label>
          </div><button type="submit" className="btn btn-primary image-generate" disabled={!canGenerate}>{studio.imgSubmitting ? '正在提交…' : busy ? '正在生成…' : reference ? '生成修改图 →' : '生成图片 →'}</button></div>
          {studio.imgPrompt.length > 2000 && <p className="image-error" role="alert">描述最多 2000 字，当前 {studio.imgPrompt.length} 字，请稍作精简。</p>}
          <StudioMediaSource media={media} locked={locked} />
          <details className="image-advanced"><summary>更多选项</summary><div className="image-advanced-body">
            <p>输出尺寸：{studio.imgSize === 'auto' ? '由模型决定；部分服务可能不支持。' : studio.imgSize.replace('x', ' × ')}。当前模型：{studio.imgChannel?.model || '服务默认模型'}。</p>
            {reference && <div className="image-mask"><label htmlFor="image-mask-upload">局部编辑蒙版</label><p>可上传与原图同尺寸的 PNG，用完全透明的区域指定修改位置；需生图服务支持。</p>
              {studio.mask && <div className="image-mask-file"><span>{studio.mask.name}</span><button type="button" className="link-btn" disabled={locked} onClick={studio.clearMask}>移除蒙版</button></div>}
              <button type="button" className="btn btn-sm" disabled={locked} onClick={()=>setMaskEditorReference(maskScope)}>涂抹修改区域</button><input id="image-mask-upload" type="file" accept="image/png" disabled={locked} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void studio.uploadReference(file, true); }} />
            </div>}<p>Ctrl / ⌘ + Enter 生成 · 描述最多 2000 字</p>
          </div></details>
          {studio.mask && reference && <p className="image-field-hint">已使用局部编辑蒙版，可在更多选项中移除。</p>}
          {studio.imgErr && <p className="image-error" role="alert">{studio.imgErr}</p>}
          {belongsToDraft && job?.state === 'error' && <p className="image-error" role="alert">生成失败：{job.error || '请重试'}</p>}
        </form>
      </section>
      <div className="image-service-status" role="status">
        {studio.loading ? <span>正在读取生图服务…</span> : studio.galleryError ? <><span>生图服务读取失败：{studio.galleryError}</span><button className="link-btn" onClick={() => void studio.refreshGallery()}>重试</button></>
          : !studio.imgChannel?.configured ? <><span>首次使用，连接你的生图服务即可开始。</span><button className="link-btn" onClick={onOpenSettings}>连接生图服务 →</button></> : <span>生成的图片会自动保存到作品中。</span>}
        {ratioMismatch && <span>服务返回的比例与所选 {size.label} 不同，画布已保留完整图片。</span>}
      </div>
      {studio.gallery.length > 0 && <section className="image-gallery" aria-label="历史图片图库"><div className="image-section-heading"><h2>最近作品</h2><button className="link-btn" onClick={onOpenOutputs}>查看全部 →</button></div><div className="image-gallery-grid">{studio.gallery.slice(0, 8).map(item => <button className="image-gallery-item" key={item.url} disabled={locked} aria-label={`用作参考图：${item.name}`} onClick={() => void studio.useGalleryReference(item)}><img src={item.url} alt={item.name} loading="lazy" /><span>{item.name}</span></button>)}</div></section>}
    </>}
    </>}
    {reference&&maskScope&&maskEditorReference===maskScope&&!videoMode&&<InpaintMaskEditor key={maskScope} reference={reference} disabled={locked} uploadError={studio.imgErr} onClose={()=>setMaskEditorReference(null)} onApply={async file=>Boolean(await studio.uploadReference(file,true))}/>}
  </div>;
}

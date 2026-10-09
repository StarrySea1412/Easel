import AspectRatioIcon from './AspectRatioIcon';
import { NativeSelect as Select } from './ui/Select';
import { useRef, useState } from 'react';
import type { VideoStudioController } from '../hooks/useVideoStudio';
import type { ImagegenGalleryItem } from '../lib/api';
import { IconImage } from './settingsIcons';
import StudioMediaSource from './StudioMediaSource';
import StudioModelControl from './StudioModelControl';
import { useStudioMediaInput } from '../hooks/useStudioMediaInput';
import { firstStudioMedia, STUDIO_MEDIA_ACCEPT } from '../lib/studioClipboard';

const EXAMPLES = [
  ['电影镜头', '清晨薄雾中的森林，镜头缓慢向前推进，阳光穿过树叶，电影质感。'],
  ['产品展示', '一杯冰咖啡放在木桌上，镜头缓慢环绕，杯壁水珠滑落，自然柔光。'],
  ['让图片动起来', '保持主体外观与构图，镜头缓慢推进，加入轻微自然运动，画面流畅稳定。'],
];

export default function VideoStudioPanel({ video, images, onOpenSettings }: {
  video: VideoStudioController; images: ImagegenGalleryItem[]; onOpenSettings: () => void;
}) {
  const uploadInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [playbackError, setPlaybackError] = useState('');
  const { reference, job, provider, busy } = video;
  const media = useStudioMediaInput(video.uploadReference, video.locked, reference?.id ?? null);
  const locked = video.locked || media.processing;
  const result = job?.state === 'done' ? job.url : null;
  const supported = provider?.modes.includes(video.mode);
  const canGenerate = !locked && !video.loading && !video.configError && provider?.configured && supported
    && video.prompt.trim().length > 0 && video.prompt.trim().length <= 2000;
  const receiveFile = (file?: File) => { if (file && !locked) void media.receiveFile(file); };

  return <>
    <StudioModelControl model={(busy && job?.model) || (reference ? provider?.imageModel : provider?.model) || ''} service={provider ? `${provider.name} · 当前视频模型` : '当前视频模型'} onSettings={onOpenSettings} />
    <section className={`image-creation video-creation${dragging ? ' is-dragging' : ''}`} aria-label="视频创作工作区"
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); if (!locked) setDragging(true); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={event => { event.preventDefault(); setDragging(false); receiveFile(event.dataTransfer.files[0]); }}
      onPaste={event => { const file = firstStudioMedia(event.clipboardData.files); if (file) { event.preventDefault(); receiveFile(file); } }}>
      <div className="image-canvas-toolbar"><span>{result ? '视频结果' : reference ? '视频首帧参考' : '视频画布'}{result && <small>{job?.ratio}{job?.duration ? ` · ${job.duration} 秒` : ''}</small>}</span>
        {result && <div className="image-result-actions"><a href={result} target="_blank" rel="noreferrer">打开视频 ↗</a><a href={result} download>下载视频</a></div>}
      </div>
      <div className={`image-canvas video-canvas${busy ? ' is-busy' : ''}`} aria-label="视频画布">
        {result ? <video key={result} className="image-canvas-picture" src={result} controls playsInline preload="metadata" aria-label="生成视频预览" onError={() => setPlaybackError(result)} />
          : reference ? <img className="image-canvas-picture" src={reference.url} alt={`视频参考图：${reference.name}`} />
          : !busy && <div className="image-canvas-empty"><span className="image-empty-symbol video-empty-symbol" aria-hidden="true">▶</span>
            <h2>{video.referenceBusy ? '正在放入参考图…' : '让一个想法，或一张图动起来'}</h2><p>描述场景、动作和镜头，直接生成视频。<br />也可以添加图片，用它作为视频的起点。</p>
            <button type="button" className="btn" disabled={locked} onClick={() => uploadInput.current?.click()}>选择视频参考图</button><small>PNG、JPG、WebP · 最大 10 MB</small>
          </div>}
        {busy && <div className="image-progress" role="status"><span className="image-progress-spinner" aria-hidden="true" /><strong>{video.submitting ? '正在提交视频…' : `正在生成视频 · 已等待 ${video.tick} 秒`}</strong><p>可以切换图片或离开此页，任务会继续。</p>
          {!video.submitting && <><button type="button" className="link-btn" disabled={video.cancelling} onClick={() => void video.cancel()}>{video.cancelling ? '正在停止…' : '停止等待'}</button><small className="video-cancel-hint">停止后仅结束本地等待和下载，服务商可能继续计费。</small></>}
        </div>}
        {dragging && <div className="image-drop-overlay">松开图片，作为视频参考</div>}
      </div>
      <form className="image-composer" onSubmit={event => { event.preventDefault(); if (canGenerate) void video.generate(); }}>
        {reference && <div className="image-attached-reference"><img src={reference.url} alt="视频首帧参考" /><span><strong>{reference.name}</strong><small>视频参考图 · {reference.width} × {reference.height}</small></span><button type="button" className="link-btn" disabled={locked} onClick={video.clearReference}>移除参考图</button></div>}
        <label className="image-prompt-label" htmlFor="video-prompt">{reference ? '这张图，你想让它怎么动？' : '你想生成什么视频？'}</label>
        <textarea id="video-prompt" rows={2} value={video.prompt} placeholder={reference ? '例如：保持主体不变，镜头缓慢推进，头发随微风轻轻摆动。' : '例如：海边日落，海浪轻拍沙滩，镜头缓慢拉远，电影感暖色。'} onChange={event => video.setPrompt(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); if (canGenerate) void video.generate(); } }} />
        {!video.prompt && <div className="image-prompt-suggestions">{(reference ? EXAMPLES.slice(2) : EXAMPLES.slice(0, 2)).map(([label, prompt]) => <button type="button" key={label} disabled={locked} onClick={() => video.setPrompt(prompt)}>{label}</button>)}</div>}
        <div className="image-composer-toolbar"><div className="image-composer-tools">
          <button type="button" className="btn image-add-reference" disabled={locked} onClick={() => uploadInput.current?.click()}><IconImage size={16} />{video.referenceBusy ? '上传中…' : reference ? '换参考图' : '添加参考图'}</button>
          <button type="button" className="btn image-add-reference" disabled={locked} onClick={() => void media.pasteClipboard()}>{media.processing ? '读取素材中…' : '从剪贴板粘贴'}</button>
          <input ref={uploadInput} aria-label="上传视频参考图" type="file" hidden accept={STUDIO_MEDIA_ACCEPT} disabled={locked} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; receiveFile(file); }} />
          <label className="image-ratio-select"><span>比例</span><Select aria-label="视频画面比例" optionIcons={Object.fromEntries((provider?.ratios || ['16:9', '9:16', '1:1']).map(ratio => [ratio, <AspectRatioIcon key={ratio} ratio={ratio}/>]))} disabled={locked || !provider} value={video.ratio} onChange={event => video.setRatio(event.target.value)}>{(provider?.ratios || ['16:9', '9:16', '1:1']).map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}</Select></label>
          <label className="image-ratio-select"><span>时长</span><Select aria-label="视频时长" disabled={locked || !provider} value={video.duration ?? ''} onChange={event => video.setDuration(event.target.value ? Number(event.target.value) : null)}><option value="">默认</option>{provider?.durations.map(duration => <option key={duration} value={duration}>{duration} 秒</option>)}</Select></label>
        </div><button type="submit" className="btn btn-primary image-generate" disabled={!canGenerate}>{video.submitting ? '正在提交…' : busy ? '正在生成…' : '生成视频 →'}</button></div>
        {video.prompt.length > 2000 && <p className="image-error" role="alert">描述最多 2000 字，当前 {video.prompt.length} 字，请稍作精简。</p>}
        <StudioMediaSource media={media} locked={locked} />
        <div className="video-provider-row"><label className="image-ratio-select"><span>视频服务</span><Select aria-label="视频服务" disabled={locked || video.loading} value={video.providerId} onChange={event => video.selectProvider(event.target.value)}>{!video.config?.providers.length && <option value="">尚未连接</option>}{video.config?.providers.map(item => <option key={item.id} value={item.id}>{item.name}{!item.configured ? ' · 未配置' : ''}</option>)}</Select></label><button type="button" className="link-btn" onClick={onOpenSettings}>配置视频服务 ↗</button></div>
        {provider && !supported && <p className="image-field-hint" role="status">当前模型仅支持{provider.modes.includes('image2video') ? '图生视频，请添加参考图' : '文生视频，请移除参考图或更换视频服务'}。</p>}
        <details className="image-advanced"><summary>模型与生成说明</summary><div className="image-advanced-body"><p>当前模型：{(reference ? provider?.imageModel : provider?.model) || '服务默认模型'}。{provider?.hint}</p><p>{video.config?.billingHint || '提交任务会调用已配置的视频服务，可能产生费用。'}</p><p>Ctrl / ⌘ + Enter 生成 · 描述最多 2000 字 · 生成结果保存到作品中</p></div></details>
        {video.error && <p className="image-error" role="alert">{video.error}</p>}
        {job?.state === 'error' && <p className="image-error" role="alert">视频生成失败：{job.error || '请重试'}</p>}
        {job?.state === 'cancelled' && <p className="image-field-hint" role="status">{job.error || video.config?.cancelHint || '已停止本地等待。'}</p>}
        {result && playbackError === result && <p className="image-error" role="alert">浏览器无法播放这个视频，请下载后查看，或重新生成。</p>}
      </form>
    </section>
    <div className="image-service-status" role="status">{video.loading ? <span>正在读取视频服务…</span> : video.configError ? <><span>视频服务读取失败：{video.configError}</span><button type="button" className="link-btn" onClick={() => void video.refresh()}>重试读取视频服务</button></>
      : !provider?.configured ? <><span>连接视频服务后，就能在这里直接生成。</span><button type="button" className="link-btn" onClick={onOpenSettings}>连接视频服务 →</button></> : <span>{provider.name} · {video.config?.billingHint}</span>}</div>
    {images.length > 0 && <details className="video-source-gallery"><summary>从最近图片选择视频参考</summary><div className="image-gallery-grid">{images.slice(0, 8).map(item => <button type="button" className="image-gallery-item" key={item.url} disabled={locked} aria-label={`用图片生成视频：${item.name}`} onClick={() => void video.useGalleryReference(item)}><img src={item.url} alt={item.name} loading="lazy" /><span>{item.name}</span></button>)}</div></details>}
    {!!video.config?.videos.length && <section className="image-gallery" aria-label="历史视频图库"><div className="image-section-heading"><h2>最近视频</h2><span>点击作品，在上方画布播放</span></div><div className="image-gallery-grid video-gallery-grid">{video.config.videos.slice(0, 8).map(item => <button type="button" className="image-gallery-item video-gallery-item" key={item.url} disabled={locked} aria-label={`播放视频：${item.name}`} onClick={() => video.previewJob(item.generation)}><span className="video-gallery-preview"><video src={item.url} preload="metadata" muted playsInline aria-hidden="true" /><i aria-hidden="true">▶</i></span><span>{item.name}</span></button>)}</div></section>}
  </>;
}

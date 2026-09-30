import { IMAGE_SIZES } from '../hooks/useImageStudio';
import type { ImageStudioController } from '../hooks/useImageStudio';
import ImageReversePanel from './ImageReversePanel';
import { IconImage } from './settingsIcons';
import { SkeletonImage } from './Skeleton';
import '../styles/image-studio.css';

const EXAMPLES = ['极简产品摄影，奶白色背景上的咖啡杯，柔和晨光，留白构图', '秋日城市漫步封面，暖色手绘插画，银杏与街角咖啡店', '未来植物温室，透明玻璃与绿色植被，电影感光影'];

export default function ImageStudioPage({ studio, onOpenSettings, onOpenOutputs, onOpenModels }: {
  studio: ImageStudioController; onOpenSettings: () => void; onOpenOutputs: () => void; onOpenModels: () => void;
}) {
  const busy = studio.imgSubmitting || studio.imgJob?.state === 'running';
  const previewSize = studio.imgSubmitting ? studio.imgSize : studio.imgJob?.size || studio.imgSize;
  const size = IMAGE_SIZES.find((item) => item.id === previewSize) || IMAGE_SIZES[0];
  const result = studio.imgJob?.state === 'done' ? studio.imgJob.url : null;
  const actual = result && studio.imgJob?.width && studio.imgJob?.height
    ? { width: studio.imgJob.width, height: studio.imgJob.height } : null;
  const automatic = previewSize === 'auto';
  const [requestedWidth, requestedHeight] = automatic ? [0, 0] : previewSize.split('x').map(Number);
  const ratioMismatch = !automatic && actual && requestedWidth > 0 && requestedHeight > 0
    && Math.abs(actual.width / actual.height - requestedWidth / requestedHeight) > .01;
  return <div className="page-scroll image-page">
    <header className="image-page-heading"><div><p className="image-eyebrow">创作工作室 / IMAGE STUDIO</p><h1 className="page-title">生图工坊</h1><p className="page-subtitle">文字生图、图片反推，作品统一保存在内容库。</p></div><div className="image-heading-actions"><button className="btn" onClick={onOpenOutputs}>查看历史作品</button><button className="btn" onClick={onOpenSettings}>生图通道设置</button></div></header>
    <div className="image-mode-tabs" role="group" aria-label="创作方式"><button className={studio.mode === 'generate' ? 'selected' : ''} aria-pressed={studio.mode === 'generate'} onClick={() => studio.setMode('generate')}>文字生图</button><button className={studio.mode === 'reverse' ? 'selected' : ''} aria-pressed={studio.mode === 'reverse'} onClick={() => studio.setMode('reverse')}>图片反推</button></div>
    {studio.mode === 'reverse' ? <ImageReversePanel studio={studio} onOpenSettings={onOpenModels} /> : <div className="image-workspace">
      <section className="card image-controls" aria-label="生图参数">
        <div className="image-section-heading"><h2>描述你的画面</h2><span className={`image-channel ${studio.imgChannel?.configured ? 'ready' : ''}`}>{studio.loading ? '读取配置中' : studio.imgChannel?.configured ? '通道已配置' : '待配置'}</span></div>
        <label htmlFor="image-prompt">画面描述</label>
        <textarea id="image-prompt" value={studio.imgPrompt} placeholder="写下画面主体、场景、风格与光线，例如：一杯咖啡放在窗边，清晨柔光，胶片摄影质感…" onChange={(event) => studio.setImgPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void studio.fireImagegen(); } }} />
        <p className="image-field-hint">Enter 换行 · Ctrl / ⌘ + Enter 生成 · {studio.imgPrompt.length} / 2000 字</p>
        <div className="image-examples"><span>试试这些灵感</span>{EXAMPLES.map((prompt, index) => <button className="btn btn-sm" key={prompt} onClick={() => studio.setImgPrompt(prompt)}>{['产品摄影', '封面插画', '场景概念'][index]}</button>)}</div>
        <fieldset className="image-size-options" disabled={busy}><legend>画面比例</legend>{IMAGE_SIZES.map((item) => <button type="button" key={item.id} className={studio.imgSize === item.id ? 'selected' : ''} aria-pressed={studio.imgSize === item.id} onClick={() => studio.setImgSize(item.id)}><span className="image-ratio-icon" style={{ aspectRatio: item.ratio }} /><strong>{item.label}</strong><small>{item.id === 'auto' ? '由模型决定' : item.id.replace('x', ' × ')}</small></button>)}</fieldset>
        {studio.imgChannel?.configured ? <p className="image-field-hint">当前模型：{studio.imgChannel.model || '服务默认模型'}</p> : <p className="image-field-hint">先在生图通道设置中填写服务地址和 API Key，再开始生成。</p>}
        <p className="image-field-hint">自动尺寸由模型决定；服务不支持时会提示错误，请改选固定比例。生成后显示实际尺寸，预览保留完整画面。</p>
        {studio.galleryError && <p className="image-error" role="alert">配置读取失败：{studio.galleryError}<button className="link-btn" onClick={() => void studio.refreshGallery()}>重试</button></p>}
        <button className="btn btn-primary image-generate" disabled={busy || !studio.imgChannel?.configured || !studio.imgPrompt.trim() || studio.imgPrompt.trim().length > 2000} onClick={() => { void studio.fireImagegen(); }}>{studio.imgSubmitting ? '正在提交…' : busy ? '正在生成…' : '生成图片 →'}</button>
        {studio.imgErr && <p className="image-error" role="alert">{studio.imgErr}</p>}
      </section>
      <section className="card image-preview" aria-label="生成预览">
        <div className="image-section-heading"><h2>画布预览</h2><span>{actual ? `实际 ${actual.width} × ${actual.height}` : size.label}</span></div>
        <div className="image-preview-stage">
          {busy ? <div className="image-progress" role="status"><SkeletonImage ratio={size.ratio} label={`正在生成 · 已等待 ${studio.imgTick} 秒`} /><p>可以切换页面，返回后会继续读取任务进度。</p></div>
            : result ? <a href={result} target="_blank" rel="noreferrer"><img src={result} alt={studio.imgJob?.prompt || '历史生成图片'} /></a>
              : <div className="image-empty"><IconImage size={42} /><strong>你的下一张作品</strong><p>在左侧描述画面，选择比例后开始生成。</p><span>产品图 / 封面插画 / 场景概念</span></div>}
        </div>
        {studio.imgJob?.state === 'error' && <p className="image-error" role="alert">生成失败：{studio.imgJob.error || '请稍后重试'}</p>}
        {ratioMismatch && <p className="image-field-hint" role="status">服务返回的比例与所选 {size.label} 不同。当前显示完整原图，可更换支持该比例的模型后重试。</p>}
        <div className="image-preview-footer"><span>生成成功后自动保存到内容库 · AI 生图</span><button className="link-btn" onClick={onOpenOutputs}>前往内容库 →</button></div>
      </section>
    </div>}
  </div>;
}

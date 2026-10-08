import type { useStudioMediaInput } from '../hooks/useStudioMediaInput';

export default function StudioMediaSource({ media, locked }: { media: ReturnType<typeof useStudioMediaInput>; locked: boolean }) {
  return <>
    {media.sourceVideo && <div className="studio-source-video">
      <video src={media.sourceVideo.url} controls playsInline preload="metadata" aria-label="参考视频本地预览" />
      <div><strong>{media.sourceVideo.name}</strong><p>已提取首帧作为图片参考。视频只在本地预览；模型收到的是首帧图片。</p>
        <button type="button" className="link-btn" disabled={locked} onClick={media.clearVideo}>关闭视频预览</button></div>
    </div>}
    <p className="studio-clipboard-hint">支持粘贴图片；浏览器提供视频文件时会提取首帧。也可选择本地视频（最大 100 MB）。</p>
    {media.error && <p className="image-error" role="alert">{media.error}</p>}
  </>;
}

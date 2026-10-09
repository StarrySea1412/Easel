import { useState } from 'react';
import type { ImageStudioController } from '../hooks/useImageStudio';
import { IMAGE_SIZES } from '../hooks/useImageStudio';
import { IconImage } from './settingsIcons';
import Select from './ui/Select';
import '../styles/image-reverse.css';

export default function ImageReversePanel({ studio, onOpenSettings }: {
  studio: ImageStudioController; onOpenSettings: () => void;
}) {
  const reverse = studio.reverse;
  const [copyStatus, setCopyStatus] = useState('');
  const [matchRatio, setMatchRatio] = useState(true);
  const ready = reverse.providers.some((item) => item.id === reverse.provider && item.configured);
  const result = reverse.result;
  const matched = result ? IMAGE_SIZES.reduce((best, item) => {
    const distance = (id: string) => {
      const [w, h] = id.split('x').map(Number);
      return Math.abs(Math.log((w / h) / (result.width / result.height)));
    };
    return distance(item.id) < distance(best.id) ? item : best;
  }) : null;

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopyStatus('已复制'); }
    catch { setCopyStatus('复制未成功，请选中文本后复制'); }
  }

  return <div className="image-workspace image-reverse-workspace">
    <section className="card image-controls" aria-label="反推参数">
      <div className="image-section-heading"><div><h2>从一张图片开始</h2><p>提取原图提示词，或分析画面生成新提示词。</p></div></div>
      <div className="image-upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
        event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) { reverse.selectFile(file); setCopyStatus(''); }
      }} onPaste={(event) => {
        const file = Array.from(event.clipboardData.files).find((item) => item.type.startsWith('image/'));
        if (file) { event.preventDefault(); reverse.selectFile(file); setCopyStatus(''); }
      }} tabIndex={0} aria-label="参考图片，可拖放或粘贴">
        {reverse.preview ? <img src={reverse.preview} alt="待反推的参考图片" /> : <IconImage size={36} />}
        <label className="btn image-upload-button" htmlFor="reverse-image-upload">{reverse.file ? '更换图片' : '选择参考图片'}</label>
        <input id="reverse-image-upload" className="image-file-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
          const file = event.target.files?.[0]; if (file) { reverse.selectFile(file); setCopyStatus(''); } event.target.value = '';
        }} />
        <p>{reverse.file ? reverse.file.name : '支持拖放，也可聚焦此区域后粘贴图片'}</p>
        <span>PNG / JPEG / WebP · 最大 8 MB、2000 万像素</span>
        {reverse.file && <button className="link-btn" onClick={() => { reverse.selectFile(null); setCopyStatus(''); }}>移除图片</button>}
      </div>
      <div className="image-reverse-fields">
        <div><label htmlFor="reverse-mode">反推方式</label><Select id="reverse-mode" disabled={reverse.busy} value={reverse.mode} onChange={(value) => reverse.setMode(value as 'auto' | 'vision')} options={[
          { value: 'auto', label: '优先读取原图提示词', description: '先检查图片元数据，未找到时分析画面' },
          { value: 'vision', label: '重新分析画面', description: '使用图片理解模型描述可见内容' },
        ]} /></div>
        <div><label htmlFor="reverse-language">分析输出语言</label><Select id="reverse-language" disabled={reverse.busy} value={reverse.language} onChange={(value) => reverse.setLanguage(value as 'zh' | 'en')} options={[
          { value: 'zh', label: '中文' }, { value: 'en', label: 'English' },
        ]} /></div>
      </div>
      <div className="image-section-heading"><label htmlFor="reverse-provider">图片理解模型</label><button type="button" className="link-btn" onClick={onOpenSettings}>模型设置与视觉测试 →</button></div>
      <Select id="reverse-provider" className="image-model-select" disabled={reverse.busy || reverse.configLoading} value={reverse.provider} onChange={reverse.setProvider} aria-describedby="reverse-provider-hint" options={[
        { value: '', label: '仅提取原图提示词', description: '读取本机元数据，无需图片理解模型' },
        ...reverse.providers.map((item) => ({ value: item.id, label: `${item.name} · ${item.model || '未填写模型'}`, description: item.configured ? '分析时将图片发送到此模型' : '未配置，请先在设置中补全模型信息', disabled: !item.configured })),
      ]} />
      <p id="reverse-provider-hint" className="image-field-hint">原图元数据在本机读取。需要分析画面时，图片会发送到所选模型；请选择支持图片输入的对话模型。</p>
      {!ready && <p className="image-field-hint">没有图片理解模型时，仍可提取图片中已有的提示词。<button className="link-btn" onClick={onOpenSettings}>配置理解模型 →</button></p>}
      {reverse.configError && <p className="image-error" role="alert">模型配置读取失败：{reverse.configError}</p>}
      <label htmlFor="reverse-instruction">补充要求 <span className="image-optional">可选</span></label>
      <textarea id="reverse-instruction" rows={2} maxLength={1000} value={reverse.instruction} onChange={(event) => reverse.setInstruction(event.target.value)} placeholder="例如：着重描述构图、材质和光线，用于产品摄影" disabled={reverse.busy} />
      <button className="btn btn-primary image-generate" disabled={!reverse.file || reverse.busy || (reverse.mode === 'vision' && !ready)} onClick={() => { setCopyStatus(''); void reverse.run(); }}>{reverse.busy ? '正在读取并分析…' : '反推提示词 →'}</button>
      {reverse.error && <p className="image-error" role="alert">{reverse.error}</p>}
    </section>
    <section className="card image-controls image-reverse-result" aria-label="反推结果">
      <div className="image-section-heading"><h2>反推结果</h2>{result && <span className="image-source">{result.source === 'metadata' ? '原图元数据' : 'AI 画面推测'}</span>}</div>
      {reverse.busy ? <div className="image-empty" role="status"><IconImage size={40} /><strong>正在寻找画面的语言</strong><p>提取主体、构图、光线、色彩和风格。</p></div>
        : result ? <>
          <p className="image-field-hint">{result.source === 'metadata'
            ? `从图片内嵌信息读取${result.metadataFormat ? ` · ${result.metadataFormat}` : ''}。保留原文语言，内容未核验。`
            : '根据可见画面生成的描述，不是作者原始提示词。'}<br />原图 {result.width} × {result.height}{result.source === 'vision' && result.model ? ` · ${result.model}` : ''}</p>
          <label htmlFor="reverse-prompt">正向提示词 <span className="image-optional">可编辑</span></label>
          <textarea id="reverse-prompt" value={reverse.prompt} onChange={(event) => { reverse.setPrompt(event.target.value); setCopyStatus(''); }} />
          {result.negativePrompt && <><label htmlFor="reverse-negative">负向提示词</label><textarea id="reverse-negative" value={result.negativePrompt} readOnly /><p className="image-field-hint">当前生图通道只接收正向描述，负向提示词可单独复制使用。</p><button className="btn btn-sm" onClick={() => void copy(result.negativePrompt || '')}>复制负向提示词</button></>}
          {matched && <label className="image-match-ratio"><input type="checkbox" checked={matchRatio} onChange={(event) => setMatchRatio(event.target.checked)} />同时选择最接近原图的比例：{matched.label}</label>}
          <div className="image-reverse-actions"><button className="btn" disabled={!reverse.prompt.trim()} onClick={() => void copy(reverse.prompt)}>复制提示词</button><button className="btn btn-primary" disabled={!reverse.prompt.trim()} onClick={() => {
            studio.setImgPrompt(reverse.prompt); if (matchRatio && matched) studio.setImgSize(matched.id); studio.setMode('generate');
          }}>填入生图描述 →</button></div>
          {reverse.prompt.length > 2000 && <p className="image-field-hint">提示词较长，生图前请精简到 2000 字以内。</p>}
          <p className="image-field-hint" role="status">{copyStatus}</p>
        </> : <div className="image-empty"><IconImage size={40} /><strong>让参考图变成创作起点</strong><p>上传图片后点击反推。<br />结果可以修改，再填入生图描述。</p><span>原图提示词 / 画面分析 / 构图参考</span></div>}
    </section>
  </div>;
}

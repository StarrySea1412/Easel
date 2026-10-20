import PublishSpinner from "./PublishSpinner";
import "../styles/analysis-progress.css";

export default function AnalysisProgress({ label = "正在读取作品", saved = false }: { label?: string; saved?: boolean }) {
  return <div className="analysis-progress" role="status">
    <div className="analysis-progress-label"><PublishSpinner /><span>{label}</span>{saved && <small>保留上次结果</small>}</div>
    <div className="analysis-progress-track" role="progressbar" aria-label={label} aria-valuetext="平台未返回完成比例"><span /></div>
  </div>;
}

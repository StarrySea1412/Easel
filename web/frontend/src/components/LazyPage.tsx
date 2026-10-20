import { Component } from 'react';
import type { ReactNode } from 'react';
import { showToast } from '../lib/toast';
import { reportPageFailure } from '../lib/api';
import { pageFailureDetails, type PageFailureDetails, type PageFailureStage } from '../lib/pageFailure';
import '../styles/page-loading.css';

export function PageLoading({ label }: { label: string }) {
  return (
    <div className="page-loading" role="status" aria-busy="true">
      <div className="page-loading-placeholder" aria-hidden="true">
        <span className="sk" /><span className="sk" /><span className="sk" />
      </div>
      <p>正在打开{label}…</p>
    </div>
  );
}

export class PageBoundary extends Component<{
  label: string; onRetry: () => void; getStage?: () => PageFailureStage; children?: ReactNode;
}, { failed: boolean; details?: PageFailureDetails; eventId?: string; reportDone?: boolean; copy?: string }> {
  state: { failed: boolean; details?: PageFailureDetails; eventId?: string; reportDone?: boolean; copy?: string } = { failed: false };
  private active = true;

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidMount() { this.active = true; }
  componentWillUnmount() { this.active = false; }

  componentDidCatch(error: Error) {
    const details = pageFailureDetails(this.props.label, this.props.getStage?.() || 'render', error);
    this.setState({ details });
    showToast(this.props.label + '暂时无法打开，请重试或刷新页面。', 'error');
    void reportPageFailure(details).then(eventId => {
      if (this.active) this.setState({ eventId, reportDone: true });
    });
  }

  render() {
    if (this.state.failed) {
      return (
        <section className="page-loading page-load-error" role="alert">
          <h2>{this.props.label}暂时无法打开</h2>
          <p>{this.state.details?.stage === 'module_load' ? '页面资源加载失败，请重试；仍失败时可刷新页面。' : '页面显示时出现异常，请重试。也可以从侧栏打开其他页面。'}</p>
          <button type="button" className="btn" onClick={this.props.onRetry}>重新尝试</button>
          <button type="button" className="btn btn-ghost" onClick={() => window.location.reload()}>刷新页面</button>
          {this.state.eventId ? <button type="button" className="btn btn-ghost" onClick={() => window.dispatchEvent(new CustomEvent('easel:failure-detail', { detail: this.state.eventId }))}>查看问题 {this.state.eventId.slice(0, 8)}</button>
            : <p role="status">{this.state.reportDone ? '诊断记录未能保存，可复制下方排查信息。' : '正在保存诊断记录…'}</p>}
          {this.state.details && <details className="page-error-details"><summary>排查信息</summary><pre>{JSON.stringify({ ...this.state.details, eventId: this.state.eventId }, null, 2)}</pre>
            <button type="button" className="btn btn-ghost" onClick={() => {
              void Promise.resolve().then(() => navigator.clipboard.writeText(JSON.stringify({ ...this.state.details, eventId: this.state.eventId }, null, 2)))
                .then(() => { if (this.active) this.setState({ copy: '已复制排查信息' }); }, () => { if (this.active) this.setState({ copy: '复制失败，请手动选择上方信息。' }); });
            }}>复制排查信息</button>{this.state.copy && <p role="status">{this.state.copy}</p>}</details>}
        </section>
      );
    }
    return this.props.children;
  }
}

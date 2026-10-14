import { Component } from 'react';
import type { ReactNode } from 'react';
import { showToast } from '../lib/toast';
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
  label: string; onRetry: () => void; children?: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch() { showToast(this.props.label + '暂时无法打开，请重试或刷新页面。', 'error'); }

  render() {
    if (this.state.failed) {
      return (
        <section className="page-loading page-load-error" role="alert">
          <h2>{this.props.label}暂时无法打开</h2>
          <p>请检查连接后重试，也可以从侧栏打开其他页面。</p>
          <button type="button" className="btn" onClick={this.props.onRetry}>重新尝试</button>
          <button type="button" className="btn btn-ghost" onClick={() => window.location.reload()}>刷新页面</button>
        </section>
      );
    }
    return this.props.children;
  }
}

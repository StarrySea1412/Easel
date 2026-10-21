import { renderMarkdown } from './sanitize';
import { externalizeMediaLinks, linkifyOutputs } from './linkifyOutputs';

export function analysisReportView(markdown: string) {
  const root = document.createElement('div');
  root.innerHTML = externalizeMediaLinks(renderMarkdown(linkifyOutputs(markdown), { allowMedia: false }));
  const sections: { title: string; html: string }[] = [];
  let current = { title: '', html: '' };
  const finish = () => { if (current.html.trim()) sections.push(current); };
  const start = (title: string) => { finish(); current = { title, html: '' }; };
  for (const child of [...root.children]) {
    const text = child.textContent?.trim() || '';
    // Only move an explicit delivery receipt when there is an actual report after it.
    if (!sections.length && !current.html && root.children.length > 1 && child.tagName === 'P'
      && /^任务已(?:全部)?完成/.test(text) && /present_artifact|artifact id|status=ready/.test(text)) continue;
    if (/^H[1-6]$/.test(child.tagName)) { start(text); continue; }
    const lead = child.firstElementChild;
    if (child.tagName === 'P' && lead?.tagName === 'STRONG' && child.firstChild === lead
      && (lead.textContent?.length || 0) <= 30 && /^\s*[:：]|^\s*[（(].*[）)][:：]/.test(text.slice(lead.textContent?.length))) {
      start(lead.textContent || ''); lead.remove();
      if (child.firstChild?.nodeType === 3) child.firstChild.textContent = child.firstChild.textContent?.replace(/^\s*[:：]\s*/, '') || '';
    }
    for (const code of child.querySelectorAll('code')) {
      if (!code.closest('pre') && /^\d{12,}$/.test(code.textContent || '')) code.classList.add('analysis-report-reference');
    }
    for (const table of [...child.querySelectorAll('table'), ...(child.tagName === 'TABLE' ? [child] : [])]) {
      const wrapper = document.createElement('div'); wrapper.className = 'analysis-report-table';
      table.replaceWith(wrapper); wrapper.append(table);
      if (table === child) { current.html += wrapper.outerHTML; break; }
    }
    if (child.tagName !== 'TABLE') current.html += child.outerHTML;
  }
  finish();
  return sections;
}

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ breaks: true, gfm: true });

/** 把 markdown 渲染成【已消毒】的 HTML。所有 dangerouslySetInnerHTML 都应走这里，防 XSS。 */
export function renderMarkdown(md: string, { allowMedia = true }: { allowMedia?: boolean } = {}): string {
  if (!md) return '';
  const raw = marked.parse(md) as string;
  if (!allowMedia) {
    // Imported transcripts are inert text snapshots: even sanitized media URLs
    // could automatically request another site's resources or local API routes.
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
        'strong', 'em', 'b', 'i', 's', 'del', 'blockquote', 'pre', 'code', 'table', 'thead',
        'tbody', 'tfoot', 'tr', 'th', 'td', 'a', 'span', 'div', 'details', 'summary', 'kbd',
        'samp', 'sup', 'sub'],
      ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan', 'start'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    });
  }
  return DOMPurify.sanitize(raw);
}

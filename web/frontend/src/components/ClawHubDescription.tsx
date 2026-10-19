import { renderMarkdown } from '../lib/sanitize';

/** Registry SKILL.md is untrusted display content; YAML is metadata, not prose. */
export function clawHubDescription(source: string, fallback = ''): { summary: string; body: string } {
  const text = source.replace(/^\uFEFF/, '').trim();
  const match = /^---[^\S\n]*\r?\n([\s\S]*?)\r?\n---[^\S\n]*(?:\r?\n|$)/.exec(text);
  if (!match) return { summary: '', body: text || fallback };
  const lines = match[1].split(/\r?\n/);
  const values: Record<string, string> = {};
  lines.forEach((line, index) => {
    const field = /^(description(?:_zh)?):\s*(.*)$/.exec(line);
    if (!field) return;
    let value = field[2].trim();
    if (/^[>|][-+]?\s*$/.test(value)) {
      const block: string[] = [];
      for (let i = index + 1; i < lines.length && (!lines[i].trim() || /^\s/.test(lines[i])); i++) block.push(lines[i].trim());
      value = block.join(' ').trim();
    }
    values[field[1]] = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  });
  return { summary: values.description_zh || values.description || fallback, body: text.slice(match[0].length).trim() };
}

export default function ClawHubDescription({ text, fallback = '' }: { text: string; fallback?: string }) {
  const content = clawHubDescription(text, fallback);
  return <div className="clawhub-readable-description">
    {content.summary && <p className="clawhub-description-summary">{content.summary}</p>}
    {content.body && <div className="skill-body-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(content.body, { allowMedia: false }) }} />}
    {!content.summary && !content.body && <p>作者未提供说明。</p>}
  </div>;
}

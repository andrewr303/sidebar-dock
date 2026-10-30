// The intermediate form every structured importer produces. Blocks become simple HTML, and the block editor's own
// htmlToMarkdown turns that into note Markdown, so imported text is escaped and nested exactly like pasted content.
//
// block: { type: 'h', level, html } | { type: 'p', html } | { type: 'quote', html } | { type: 'hr' }
//      | { type: 'li', ordered, level, html, start?, checked? } | { type: 'code', text, language }
//      | { type: 'table', rows: [[cellHtml]] }
// `html` is inline HTML that is already escaped (use esc() for plain text and inline() for runs).

// Windows-1252 decoded with an explicit table: some runtimes treat the "windows-1252" label as Latin-1, which turns
// curly quotes, dashes and bullets (0x80-0x9F) into invisible control characters.
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
export function cp1252(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x4000) {
    const chunk = bytes.subarray(i, i + 0x4000);
    out += String.fromCharCode.apply(null, chunk).replace(/[\u0080-\u009f]/g, ch => CP1252_HIGH[ch.charCodeAt(0) - 0x80]);
  }
  return out;
}

export const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const safeHref = href => /^(https?:|mailto:)/i.test(String(href || '').trim()) ? String(href).trim() : '';

/**
 * Inline runs to HTML: [{ text, bold, italic, strike, code, href }]. Neighbouring runs with the same link share one
 * <a>; line breaks in text become <br>.
 */
export function inline(runs) {
  const merged = [];
  for (const run of runs) {
    if (!run || !run.text) continue;
    const last = merged.at(-1);
    if (last && ['bold', 'italic', 'strike', 'code', 'href'].every(key => (last[key] || '') === (run[key] || ''))) last.text += run.text;
    else merged.push({ ...run });
  }
  let out = '';
  for (let k = 0; k < merged.length;) {
    const href = safeHref(merged[k].href);
    let end = k + 1;
    while (end < merged.length && safeHref(merged[end].href) === href) end++;
    const body = merged.slice(k, end).map(run => {
      let piece = esc(run.text).replace(/\n/g, '<br>');
      if (run.code) piece = `<code>${piece}</code>`;
      if (run.strike) piece = `<del>${piece}</del>`;
      if (run.italic) piece = `<em>${piece}</em>`;
      if (run.bold) piece = `<strong>${piece}</strong>`;
      return piece;
    }).join('');
    out += href ? `<a href="${esc(href)}">${body}</a>` : body;
    k = end;
  }
  return out;
}

export function blocksToHtml(blocks) {
  let out = '';
  const lists = [];
  const close = depth => { while (lists.length > depth) out += `</${lists.pop()}>`; };
  for (const block of blocks) {
    if (!block) continue;
    if (block.type !== 'li') close(0);
    switch (block.type) {
      case 'h': { const level = Math.max(1, Math.min(6, Number(block.level) || 1)); if (block.html.trim()) out += `<h${level}>${block.html}</h${level}>`; break; }
      case 'p': if (block.html.trim()) out += `<p>${block.html}</p>`; break;
      case 'quote': if (block.html.trim()) out += `<blockquote><p>${block.html}</p></blockquote>`; break;
      case 'hr': out += '<hr>'; break;
      case 'code': out += `<pre><code${block.language ? ` class="language-${esc(block.language)}"` : ''}>${esc(block.text)}</code></pre>`; break;
      case 'table': {
        const rows = (block.rows || []).filter(row => row.some(cell => String(cell).replace(/<br>/g, '').trim()));
        if (!rows.length) break;
        const width = Math.max(...rows.map(row => row.length));
        out += `<table>${rows.map((row, r) => `<tr>${Array.from({ length: width }, (_, c) => r === 0 ? `<th>${row[c] || ''}</th>` : `<td>${row[c] || ''}</td>`).join('')}</tr>`).join('')}</table>`;
        break;
      }
      case 'li': {
        const depth = Math.max(0, Math.min(5, Number(block.level) || 0)) + 1;
        const tag = block.ordered ? 'ol' : 'ul';
        close(depth);
        if (lists.length === depth && lists.at(-1) !== tag) close(depth - 1);
        while (lists.length < depth) {
          const own = lists.length === depth - 1, kind = own ? tag : 'ul';
          out += `<${kind}${own && kind === 'ol' && block.start > 1 ? ` start="${Number(block.start)}"` : ''}>`;
          lists.push(kind);
        }
        out += `<li>${typeof block.checked === 'boolean' ? `<input type="checkbox"${block.checked ? ' checked' : ''}>` : ''}${block.html}</li>`;
        break;
      }
      default: break;
    }
  }
  close(0);
  return out;
}

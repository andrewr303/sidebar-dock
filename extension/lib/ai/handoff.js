// Hand a prompt to a consumer AI app by URL. None of these links are formal APIs: keep URLs short, and copy the full
// prompt to the clipboard as well (handoffPlan says when that matters most).

export const MAX_HANDOFF_URL = 8000;

export const HANDOFF_TARGETS = Object.freeze([
  Object.freeze({ id: 'claude', name: 'Claude', base: 'https://claude.ai/new', param: 'q', prefill: 'yes', maxPromptChars: 14000 }),
  Object.freeze({ id: 'chatgpt', name: 'ChatGPT', base: 'https://chatgpt.com/', param: 'q', prefill: 'yes' }),
  Object.freeze({ id: 'grok', name: 'Grok', base: 'https://grok.com/', param: 'q', prefill: 'yes' }),
  Object.freeze({ id: 'perplexity', name: 'Perplexity', base: 'https://www.perplexity.ai/search', param: 'q', prefill: 'yes', autoSubmit: true }),
  Object.freeze({ id: 'gemini', name: 'Gemini', base: 'https://gemini.google.com/app', param: 'q', prefill: 'unreliable' }),
  Object.freeze({ id: 'copilot', name: 'Copilot', base: 'https://copilot.microsoft.com/', param: 'q', prefill: 'unreliable' }),
  Object.freeze({ id: 'claude-code', name: 'Claude Code', base: 'https://claude.ai/code', param: 'prompt', prefill: 'yes' }),
]);

export function handoffTarget(id) {
  const target = HANDOFF_TARGETS.find(entry => entry.id === id);
  if (!target) throw new Error('Choose Claude, ChatGPT, Grok, Perplexity, Gemini or Copilot.');
  return target;
}

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const clip = (value, max) => value.length > max ? `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…` : value;
const safeUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };

// Markdown prompt: the question first, then numbered sources with links and short excerpts.
export function buildHandoffPrompt({ question = '', sources = [], sourceChars = 600 } = {}) {
  const lines = [String(question ?? '').trim()];
  const list = (Array.isArray(sources) ? sources : []).filter(Boolean);
  if (list.length) {
    lines.push('', 'Sources from my Still library:', '');
    list.forEach((source, index) => {
      const title = clean(source.title) || clean(source.url) || 'Untitled';
      const url = safeUrl(source.url);
      lines.push(`${index + 1}. ${url ? `[${title.replace(/[[\]]/g, '')}](${url})` : title}`);
      const excerpt = sourceChars > 0 ? clip(clean(source.excerpt || source.snippet || source.text || source.content || ''), sourceChars) : '';
      if (excerpt) lines.push(`   > ${excerpt}`);
    });
  }
  return lines.join('\n').trim();
}

const urlFor = (target, text) => `${target.base}?${target.param}=${encodeURIComponent(text)}`;

function fits(target, text, maxLength) {
  return urlFor(target, text).length <= maxLength && (!target.maxPromptChars || text.length <= target.maxPromptChars);
}

function truncateText(target, text, maxLength) {
  if (fits(target, text, maxLength)) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(target, `${text.slice(0, middle)}…`, maxLength)) low = middle; else high = middle - 1;
  }
  let cut = low;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return cut > 0 ? `${text.slice(0, cut).trimEnd()}…` : '';
}

// Returns { url, prompt, fullPrompt, truncated, copyFirst }. For { question, sources } input, sources shrink and drop
// before the question is ever cut.
export function handoffPlan(targetId, prompt, { maxLength = MAX_HANDOFF_URL } = {}) {
  const target = handoffTarget(targetId);
  const structured = prompt && typeof prompt === 'object';
  const full = structured ? buildHandoffPrompt(prompt) : String(prompt ?? '');
  let text = full;
  if (structured && !fits(target, text, maxLength)) {
    const sources = Array.isArray(prompt.sources) ? prompt.sources.filter(Boolean) : [];
    let found = null;
    for (const sourceChars of [300, 120, 0]) {
      const candidate = buildHandoffPrompt({ ...prompt, sources, sourceChars });
      if (fits(target, candidate, maxLength)) { found = candidate; break; }
    }
    for (let count = sources.length - 1; !found && count >= 0; count--) {
      const candidate = buildHandoffPrompt({ ...prompt, sources: sources.slice(0, count), sourceChars: 0 });
      if (fits(target, candidate, maxLength)) found = candidate;
    }
    text = found || String(prompt.question ?? '').trim();
  }
  text = truncateText(target, text, maxLength);
  const truncated = text !== full;
  return { target: target.id, name: target.name, url: urlFor(target, text), prompt: text, fullPrompt: full, truncated, copyFirst: truncated || target.prefill !== 'yes' };
}

export function handoffUrl(target, prompt, options) {
  return handoffPlan(target, prompt, options).url;
}

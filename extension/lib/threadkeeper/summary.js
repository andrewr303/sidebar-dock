// Chat summaries: the Markdown a chat page's Summary view renders from the stored Threadkeeper record, built only from
// the blocks lib/markdown.js supports (headings, paragraphs, lists, task lines, a callout, code). Pure and DOM-free, so
// the assistant (lib/ai) can build the same text for a chat it puts in context.
//
// Every string comes from another extension and, before that, from an AI conversation: it is untrusted. It never becomes
// raw HTML (renderMarkdown escapes HTML anyway) and the Markdown syntax in it is escaped, so a gist cannot open a
// heading, a list, a link, a [[wiki link]], an embed or a page block. Message references are the one link the builder
// writes itself: [m3](#msg-2) points at the third message (indexes are 0-based, labels 1-based).

const MAX_REFS = 4;
const STATES = { active: 'Active', needs_review: 'Needs review', waiting: 'Waiting', paused: 'Paused', done: 'Done', archived: 'Archived' };
const CATEGORY_LABELS = { chat: 'Chat', coding_agent: 'Coding agent', agent: 'Agent', builder: 'Builder', search: 'Search', companion: 'Companion' };
const ARTIFACT_KINDS = { code: 'code', file: 'file', document: 'document', doc: 'document', link: 'link', image: 'image', data: 'data', command: 'command', config: 'config', plan: 'plan' };

const text = value => (typeof value === 'string' ? value : value == null ? '' : String(value));
/** One line: newlines and runs of spaces collapse, control and bidi-override characters go. */
export const oneLine = value => text(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
const list = value => (Array.isArray(value) ? value : []);
const same = (a, b) => oneLine(a).toLowerCase().replace(/[.!?…]+$/, '') === oneLine(b).toLowerCase().replace(/[.!?…]+$/, '');

/** A workflow state as a label ('' for an unknown one). */
export const workflowLabel = state => STATES[state] || '';
/** A provider category as a label ('Chat' for an unknown one). */
export const categoryLabel = category => CATEGORY_LABELS[category] || CATEGORY_LABELS.chat;

/**
 * Escapes the Markdown syntax of one line of untrusted text so it renders as written: inline marks (* _ ~ ` [ ] ! < > |
 * \ and #), and anything at the start of the line that would open a block (a list, a numbered list, a quote, a heading,
 * a divider, a fence, a toggle or an embed). Newlines collapse to spaces.
 */
export function escapeMarkdown(value) {
  let out = oneLine(value).replace(/[\\`*_~[\]!<>|#]/g, '\\$&');
  // Block openers that survive the inline escapes: "- x", "+ x", "1. x", "1) x", "---", ":::toggle", "::embed".
  out = out.replace(/^([-+:=])/, '\\$1').replace(/^(\d+)([.)])(?=\s|$)/, '$1\\$2');
  return out;
}

/** A Markdown code span that cannot be closed early by backticks inside it. */
export function inlineCode(value) {
  const body = oneLine(value);
  if (!body) return '';
  const longest = Math.max(0, ...(body.match(/`+/g) || []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return longest ? `${fence} ${body} ${fence}` : `${fence}${body}${fence}`;
}

/** A fenced code block whose fence is longer than any backtick run in the content. */
export function codeBlock(value, language = '') {
  const body = text(value).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const longest = Math.max(2, ...(body.match(/`+/g) || []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${body}\n${fence}`;
}

/** [m3](#msg-2) for 0-based message index 2. */
export const messageRef = index => `[m${index + 1}](#msg-${index})`;

/** " [m3](#msg-2) [m7](#msg-6)": valid, deduped, sorted indexes, at most four. '' when there are none. */
export function refsMarkdown(refs, { limit = MAX_REFS } = {}) {
  const valid = [...new Set(list(Array.isArray(refs) ? refs : refs == null ? [] : [refs])
    .map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < 1e6))].sort((a, b) => a - b).slice(0, limit);
  return valid.length ? ` ${valid.map(messageRef).join(' ')}` : '';
}

/** The paragraphs of a block of untrusted prose, each escaped (blank lines separate paragraphs). */
function paragraphs(value) {
  return text(value).split(/\n\s*\n/).map(escapeMarkdown).filter(Boolean);
}

/** Lowercase, punctuation-free text for comparing an item with the next step. */
const key = value => oneLine(value).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').replace(/\s+/g, ' ').trim();

const QUOTE_RE = /^(?:cd '((?:[^'\\]|'\\'')*)' && )?(claude --resume|codex resume) '([\w-]{1,128})'$/;
const quoteArg = value => `'${String(value).replace(/'/g, "'\\''")}'`;

/**
 * The resume command of a CLI thread, rebuilt from validated parts: `claude --resume '<id>'` for Claude Code and
 * `codex resume '<id>'` for Codex, optionally after `cd '<path>' &&`. Anything that does not parse exactly, names
 * another provider, or carries a path with control characters gives ''.
 */
export function safeResumeCommand(thread) {
  const raw = text(thread?.resumeCommand).trim();
  const match = QUOTE_RE.exec(raw);
  if (!match) return '';
  const [, quotedPath, tool, id] = match;
  const provider = text(thread?.provider);
  if ((tool === 'claude --resume' && provider !== 'claude_code') || (tool === 'codex resume' && provider !== 'codex')) return '';
  const path = quotedPath === undefined ? '' : quotedPath.replace(/'\\''/g, "'");
  if (/[\u0000-\u001f\u007f]/.test(path) || path.length > 400) return '';
  return `${path ? `cd ${quoteArg(path)} && ` : ''}${tool} ${quoteArg(id)}`;
}

const defaultDate = iso => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

/** Bullet for an evidence item: text, then " — rationale" when given, then refs. */
function evidenceLine(entry, { rationale = true } = {}) {
  const body = escapeMarkdown(entry?.text);
  if (!body) return '';
  const why = rationale && oneLine(entry?.rationale) && !same(entry.rationale, entry.text) ? ` — ${escapeMarkdown(entry.rationale)}` : '';
  return `${body}${why}${refsMarkdown(entry?.refs)}`;
}

/**
 * The Summary view of a chat. record: getChatRecord(id) ({ thread } with Threadkeeper's analysis) or null; item: the
 * library chat item (its excerpt stands in for the gist when no record is stored). Sections appear only with content:
 * What this thread is about, the at-a-glance lines (Goal, Outcome, Status), Key points, Where you left off, Decisions,
 * Constraints, Next steps, Open questions, What was produced and Context. Returns '' when there is nothing to show.
 * options.formatDate(iso) formats dates (default: the browser's short date).
 */
export function buildChatSummaryMarkdown(record, item = {}, { formatDate = defaultDate } = {}) {
  const thread = record?.thread && typeof record.thread === 'object' ? record.thread : {};
  const analysis = thread.analysis && typeof thread.analysis === 'object' ? thread.analysis : {};
  const chat = item?.chat && typeof item.chat === 'object' ? item.chat : {};
  const out = [];
  const section = (title, body) => { if (body.length) out.push(`## ${title}`, ...body); };

  // 1. What this thread is about: the gist leads, then the in-depth overview (or the older one-paragraph summary).
  const gist = oneLine(analysis.gist || thread.gist || item?.excerpt);
  const about = gist ? [escapeMarkdown(gist)] : [];
  const overview = list(analysis.overview).flatMap(paragraphs).filter(p => !same(p.replace(/\\/g, ''), gist));
  if (overview.length) about.push(...overview);
  else if (oneLine(analysis.summary) && !same(analysis.summary, gist)) about.push(...paragraphs(analysis.summary));
  section('What this thread is about', about);

  // 2. At a glance.
  const glance = [];
  if (oneLine(analysis.userGoal)) glance.push(`**Goal:** ${escapeMarkdown(analysis.userGoal)}`);
  if (oneLine(analysis.outcome)) glance.push(`**Outcome:** ${escapeMarkdown(analysis.outcome)}`);
  const state = workflowLabel(thread.workflowState || chat.workflowState);
  const reason = oneLine(analysis.statusReason);
  if (state || reason) glance.push(`**Status:** ${[state, reason ? escapeMarkdown(reason) : ''].filter(Boolean).join(' — ')}`);
  if (glance.length) out.push(...glance);

  // 3. Key points.
  section('Key points', list(analysis.keyPoints).map(entry => evidenceLine(entry, { rationale: false })).filter(Boolean).map(line => `- ${line}`));

  // 4. Where you left off, with the single next step.
  const left = analysis.whereYouLeftOff && oneLine(analysis.whereYouLeftOff.text) ? analysis.whereYouLeftOff : null;
  const nextStep = oneLine(analysis.nextStep);
  const leftBody = [];
  if (left) leftBody.push('> [!NOTE]', `> ${escapeMarkdown(left.text)}${refsMarkdown(left.refs)}`);
  if (nextStep) leftBody.push(`**Next step:** ${escapeMarkdown(nextStep)}`);
  section('Where you left off', leftBody);

  // 5. Decisions: what you settled on, then what was only suggested.
  const decisions = list(analysis.decisions).filter(entry => oneLine(entry?.text));
  const mine = decisions.filter(entry => entry.speaker !== 'assistant_suggested').map(entry => evidenceLine(entry)).filter(Boolean);
  const suggested = decisions.filter(entry => entry.speaker === 'assistant_suggested').map(entry => evidenceLine(entry)).filter(Boolean);
  if (mine.length && suggested.length) section('Decisions', ['### You decided', ...mine.map(l => `- ${l}`), '### Suggested', ...suggested.map(l => `- ${l}`)]);
  else if (mine.length) section('Decisions', mine.map(l => `- ${l}`));
  else if (suggested.length) section('Decisions', ['*Suggested, not confirmed:*', ...suggested.map(l => `- ${l}`)]);

  // Constraints (requirements and limits the thread worked within).
  section('Constraints', list(analysis.constraints).map(entry => evidenceLine(entry)).filter(Boolean).map(line => `- ${line}`));

  // 6. Next steps: open action items as tasks (the next step above is not repeated).
  const step = key(nextStep);
  section('Next steps', list(analysis.actionItems).filter(entry => oneLine(entry?.text) && (!step || key(entry.text) !== step))
    .map(entry => evidenceLine(entry)).filter(Boolean).map(line => `- [ ] ${line}`));

  // 7. Open questions.
  section('Open questions', list(analysis.openQuestions).map(entry => evidenceLine(entry)).filter(Boolean).map(line => `- ${line}`));

  // 8. What was produced.
  section('What was produced', list(analysis.artifacts).filter(entry => oneLine(entry?.label)).map(entry => {
    const kind = ARTIFACT_KINDS[oneLine(entry.kind).toLowerCase()] || '';
    const description = oneLine(entry.description) && !same(entry.description, entry.label) ? ` — ${escapeMarkdown(entry.description)}` : '';
    return `- **${escapeMarkdown(entry.label)}**${description}${kind ? ` (${kind})` : ''}${refsMarkdown(entry.ref)}`;
  }));

  // 9. Context.
  const context = [];
  const topics = [...new Set([...list(analysis.topics), ...list(chat.topics)].map(oneLine).filter(Boolean))].slice(0, 12);
  if (topics.length) context.push(`**Topics:** ${topics.map(topic => `\\#${escapeMarkdown(topic.replace(/\s+/g, '-'))}`).join(' ')}`);
  const entities = [...new Set(list(analysis.entities).map(oneLine).filter(Boolean))].slice(0, 16);
  if (entities.length) context.push(`**Mentions:** ${entities.map(escapeMarkdown).join(', ')}`);
  const languages = [...new Set(list(analysis.languages).map(oneLine).filter(Boolean))].slice(0, 8);
  if (languages.length) context.push(`**Languages:** ${languages.map(escapeMarkdown).join(', ')}`);
  const project = oneLine(thread.project || chat.project);
  if (project && !/^unfiled\b/i.test(project)) context.push(`**Project:** ${escapeMarkdown(project)}`);
  const provider = oneLine(thread.providerLabel || chat.providerLabel || item?.siteName);
  const agent = oneLine(thread.agentLabel);
  if (provider || agent) context.push(`**${agent ? 'Agent' : 'Provider'}:** ${[agent, provider].filter(Boolean).map(escapeMarkdown).join(' · ')}`);
  const kind = oneLine(analysis.kindLabel || thread.kindLabel || chat.kindLabel);
  if (kind) context.push(`**Kind:** ${escapeMarkdown(kind)}`);
  const model = oneLine(thread.model || chat.model);
  if (model) context.push(`**Model:** ${inlineCode(model)}`);
  const workspace = oneLine(thread.workspacePath);
  const branch = oneLine(thread.gitBranch);
  if (workspace || branch) context.push(`**Workspace:** ${[workspace ? inlineCode(workspace) : '', branch ? `on ${inlineCode(branch)}` : ''].filter(Boolean).join(' ')}`);
  const started = formatDate(thread.createdAt || chat.startedAt || '');
  const updated = formatDate(thread.updatedAt || chat.lastActivityAt || '');
  if (started || updated) context.push(`**Dates:** ${[started ? `started ${started}` : '', updated && updated !== started ? `last activity ${updated}` : ''].filter(Boolean).join(', ')}`);
  if (analysis.source === 'ai') {
    const by = oneLine(analysis.modelLabel || analysis.model);
    const when = formatDate(analysis.generatedAt || '');
    context.push(`**Summary:** written by ${by ? escapeMarkdown(by) : 'an AI model'}${when ? ` on ${when}` : ''}`);
  } else if (analysis.source === 'local') context.push('**Summary:** written on this device by Threadkeeper');
  const resume = safeResumeCommand(thread);
  if (resume) context.push('**Resume in a terminal:**', codeBlock(resume, 'sh'));
  section('Context', context);

  return out.join('\n');
}

/**
 * Brings model-written Markdown in line with what lib/markdown.js reads: #### and deeper headings become ###, "+ item"
 * lists become "- item" and "1) item" becomes "1. item". Lines inside fenced code are left alone.
 */
export function normalizeLlmMarkdown(markdown) {
  let fence = '';
  return text(markdown).replace(/\r\n?/g, '\n').split('\n').map(line => {
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !line.trim().slice(open[1].length).trim()) fence = '';
      return line;
    }
    if (open) { fence = open[1]; return line; }
    return line
      .replace(/^(\s{0,3})#{4,}(?=[ \t])/, '$1###')
      .replace(/^(\s*)\+(?=[ \t]+\S)/, '$1-')
      .replace(/^(\s*)(\d{1,9})\)(?=[ \t]+\S)/, '$1$2.');
  }).join('\n');
}

// Sample library written on first run only (store.loadLibrary seeds an empty store). Plain, realistic content
// that shows collections, nesting, page-linked notes, tasks, highlights and links between items.
const now = Date.now();
const day = 86400000;
const stamp = days => new Date(now - days * day).toISOString();
const item = (id, type, title, props = {}, days = 0) => ({
  id, type, title, url: '', excerpt: '', content: '', tags: [], collectionId: '', favorite: false, archived: false, deletedAt: null,
  createdAt: stamp(days), updatedAt: stamp(days), highlights: [], relatedIds: [], ...props,
});

const welcome = `Still keeps links, notes and highlights in one local library, with AI that can read it when you ask.

## Save things
- Press **Alt+Shift+S** on any page, or use **Save** in the side panel's *This page* tab.
- Hover a collection in the sidebar and press **+** to save the current page straight into it.
- Right-click a page or link and choose **Save page to** to pick a collection.

## Write notes
- Notes can belong to a page. Open the side panel on that page to see them.
- Type **/** for blocks, **[[** to link another note or item, and use checklists for tasks.

## Ask AI
- Connect Claude, ChatGPT, Grok, Gemini or a local model in **Settings > AI models**.
- Ask about this page, a collection or your whole library. Changes it proposes wait for your approval.

- [ ] Save your first page
- [ ] Write a note on a page you are reading
- [ ] Connect an AI model`;

const principles = `Notes from [[Aesthetic and Minimalist Design]] and [[Refactoring UI]].

- Start with too much white space, then remove it.
- Not every element needs to compete for attention. De-emphasize to emphasize.
- Use one accent color. Let images and collection colors carry the rest.

## Next
- [x] Collect references
- [ ] Define type scale and spacing tokens
- [ ] Review dark mode contrast`;

const agents = `> The most successful implementations use simple, composable patterns rather than complex frameworks.

- **Prompt chaining** for fixed multi-step tasks
- **Routing** to send easy questions to a fast model
- **Evaluator loop** when quality can be checked

- [x] Read the article
- [ ] Try routing in the tagging flow
- [ ] Compare with [[Model Context Protocol: Introduction]]`;

export const SEED_LIBRARY = {
  schemaVersion: 1,
  updatedAt: stamp(0),
  settings: { theme: 'system', accent: 'blue', density: 'comfortable' },
  collections: [
    { id: 'design', name: 'Design', color: '#d9467a', icon: 'palette', parentId: '' },
    { id: 'design-inspiration', name: 'Inspiration', color: '#e08a1e', icon: 'lightbulb', parentId: 'design' },
    { id: 'design-type', name: 'Typography', color: '#5b5bd6', icon: 'type', parentId: 'design' },
    { id: 'ai', name: 'AI & Agents', color: '#8e4ec6', icon: 'sparkles', parentId: '', pinned: true },
    { id: 'dev', name: 'Development', color: '#0d74ce', icon: 'code', parentId: '' },
    { id: 'reading', name: 'Reading list', color: '#cc4e00', icon: 'book-open', parentId: '' },
    { id: 'travel', name: 'Travel', color: '#12a594', icon: 'plane', parentId: '' },
  ],
  items: [
    item('welcome', 'note', 'Welcome to Still', { content: welcome, excerpt: 'Still keeps links, notes and highlights in one local library, with AI that can read it when you ask.', pinned: true, tags: ['getting-started'] }, 0),
    item('effective-agents', 'article', 'Building effective agents', {
      url: 'https://www.anthropic.com/engineering/building-effective-agents', collectionId: 'ai', favorite: true, tags: ['ai', 'agents'],
      excerpt: 'Patterns for building LLM agents: prompt chaining, routing, parallelization, orchestrator-workers and evaluator-optimizer loops.',
      highlights: [{ id: 'h-agents-1', text: 'The most successful implementations use simple, composable patterns rather than complex frameworks.', color: 'yellow' }],
      relatedIds: ['note-agents'],
    }, 1),
    item('note-agents', 'note', 'Notes on agent patterns', { url: 'https://www.anthropic.com/engineering/building-effective-agents', content: agents, excerpt: 'Prompt chaining, routing and evaluator loops, with next steps.', collectionId: 'ai', tags: ['agents'], relatedIds: ['effective-agents', 'mcp-intro'] }, 1),
    item('mcp-intro', 'article', 'Model Context Protocol: Introduction', { url: 'https://modelcontextprotocol.io/docs/getting-started/intro', collectionId: 'ai', tags: ['ai', 'mcp'], excerpt: 'An open protocol that connects AI applications to data sources and tools.' }, 2),
    item('claude-docs', 'bookmark', 'Claude Developer Platform docs', { url: 'https://docs.claude.com/', collectionId: 'ai', tags: ['ai', 'docs'], excerpt: 'Guides and API reference for building with Claude.' }, 3),
    item('quiet-design', 'article', 'Aesthetic and Minimalist Design', {
      url: 'https://www.nngroup.com/articles/aesthetic-minimalist-design/', collectionId: 'design-inspiration', favorite: true, tags: ['design', 'ux'],
      excerpt: 'Interfaces should not contain information that is irrelevant or rarely needed.',
      highlights: [{ id: 'h-design-1', text: 'Every extra unit of information competes with the relevant units of information.', color: 'yellow', note: 'Use this for the empty states.' }],
      relatedIds: ['note-principles'],
    }, 2),
    item('refactoring-ui', 'bookmark', 'Refactoring UI', { url: 'https://www.refactoringui.com/', collectionId: 'design-inspiration', tags: ['design', 'ui'], excerpt: 'Practical tactics for designing interfaces: hierarchy, spacing, color and depth.' }, 4),
    item('note-principles', 'note', 'Design principles for the redesign', { url: 'https://www.nngroup.com/articles/aesthetic-minimalist-design/', content: principles, excerpt: 'Start with too much white space, then remove it.', collectionId: 'design', tags: ['design'], relatedIds: ['quiet-design', 'refactoring-ui'] }, 2),
    item('practical-typography', 'bookmark', 'Practical Typography', { url: 'https://practicaltypography.com/', collectionId: 'design-type', tags: ['typography'], excerpt: 'Rules for body text, line length, point size and line spacing.' }, 5),
    item('inter', 'bookmark', 'Inter typeface family', { url: 'https://rsms.me/inter/', collectionId: 'design-type', tags: ['typography', 'fonts'], excerpt: 'A typeface carefully crafted for computer screens.' }, 6),
    item('web-dev', 'bookmark', 'Learn web development', { url: 'https://web.dev/learn', collectionId: 'dev', tags: ['development', 'learning'], excerpt: 'Courses on HTML, CSS, accessibility, performance and more.' }, 7),
    item('mdn-css', 'bookmark', 'CSS reference', { url: 'https://developer.mozilla.org/en-US/docs/Web/CSS', collectionId: 'dev', tags: ['css', 'reference'], excerpt: 'Every CSS property, selector and at-rule, with examples.' }, 8),
    item('makers-schedule', 'article', "Maker's Schedule, Manager's Schedule", { url: 'https://paulgraham.com/makersschedule.html', collectionId: 'reading', tags: ['essays', 'productivity'], excerpt: 'Why meetings cost makers more than managers.' }, 9),
    item('kyoto', 'bookmark', 'Kyoto travel guide', { url: 'https://www.japan-guide.com/e/e2158.html', collectionId: 'travel', tags: ['japan', 'travel'], excerpt: 'Temples, gardens and neighborhoods worth the walk.' }, 10),
    item('linear-method', 'bookmark', 'The Linear Method', { url: 'https://linear.app/method', tags: ['product'], excerpt: 'Practices for building software: direction, short cycles and focus.' }, 0),
    item('raindrop', 'bookmark', 'Raindrop.io', { url: 'https://raindrop.io/', tags: [], excerpt: 'All-in-one bookmark manager.' }, 1),
  ],
};

// WORKSTREAM-STUB(sd-ui): contract placeholder. The sd-ui workstream replaces this with the full summary builder.
/** buildChatSummaryMarkdown(record, item) → Markdown for the chat Summary view (record = getChatRecord(id)). */
export function buildChatSummaryMarkdown(record, item = {}) {
  const thread = record?.thread || {};
  const gist = thread.analysis?.gist || item.excerpt || '';
  return gist ? `## What this thread is about\n\n${gist}` : '';
}

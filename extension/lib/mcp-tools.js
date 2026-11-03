// The bridge's MCP tools as Settings → Agents & MCP lists them. Pure data, so tests can check it against
// bridge/protocol.mjs TOOLS (tests/mcp-tools-sync.test.mjs). access mirrors the tool annotations and the token scopes:
// 'read' (readOnlyHint, in every scope), 'write' (changes that Everyday work allows) and 'destructive' (Full access only).

export const MCP_TOOLS = Object.freeze([
  { name: 'bridge_status', access: 'read', text: 'Check that Still is open and in sync' },
  { name: 'library_capabilities', access: 'read', text: 'Describe what agents can read and change' },
  { name: 'search_library', access: 'read', text: 'Search by keyword' },
  { name: 'semantic_search', access: 'read', text: 'Search by meaning (needs Semantic search)' },
  { name: 'list_items', access: 'read', text: 'List items, including archived and trashed ones' },
  { name: 'get_item', access: 'read', text: 'Read an item with its notes and highlights' },
  { name: 'get_related_items', access: 'read', text: 'Read links and backlinks' },
  { name: 'list_collections', access: 'read', text: 'List collections' },
  { name: 'get_collection', access: 'read', text: 'Read one collection' },
  { name: 'list_tags', access: 'read', text: 'List tags with counts' },
  { name: 'export_item', access: 'read', text: 'Export one item as JSON or Markdown' },
  { name: 'export_library', access: 'read', text: 'Export the library page by page' },
  { name: 'read_file', access: 'read', text: 'Read an attached file in chunks' },
  { name: 'get_operation', access: 'read', text: 'Check whether a change was saved' },
  { name: 'create_item', access: 'write', text: 'Save a page into a collection or write a note' },
  { name: 'update_item', access: 'write', text: 'Edit titles, notes, tags and other details' },
  { name: 'move_page', access: 'write', text: 'Move a note page inside another page or back to the top level' },
  { name: 'update_article_content', access: 'destructive', text: 'Replace saved article text' },
  { name: 'create_collection', access: 'write', text: 'Create a collection' },
  { name: 'update_collection', access: 'write', text: 'Rename, recolor or move a collection' },
  { name: 'delete_collection', access: 'destructive', text: 'Delete a collection (its items move to Inbox)' },
  { name: 'trash_item', access: 'write', text: 'Move an item to Trash' },
  { name: 'restore_item', access: 'write', text: 'Restore an item from Trash' },
  { name: 'permanently_delete_item', access: 'destructive', text: 'Delete a trashed item forever, after confirming' },
  { name: 'add_highlight', access: 'write', text: 'Add a highlight' },
  { name: 'update_highlight', access: 'write', text: 'Edit a highlight or its note' },
  { name: 'remove_highlight', access: 'write', text: 'Remove a highlight' },
  { name: 'link_items', access: 'write', text: 'Link one item to another' },
  { name: 'unlink_items', access: 'write', text: 'Remove a link between items' },
  { name: 'set_item_tags', access: 'write', text: 'Set an item’s tags' },
  { name: 'bulk_update_items', access: 'destructive', text: 'Move, tag or favorite up to 100 items at once' },
  { name: 'rename_tag', access: 'destructive', text: 'Rename a tag everywhere' },
  { name: 'remove_tag', access: 'destructive', text: 'Remove a tag everywhere' },
].map(tool => Object.freeze({ ...tool, write: tool.access !== 'read' })));

/** Token scopes for agent clients such as Paperclip (bridge/config.mjs ensureClientToken). */
export const MCP_SCOPES = Object.freeze([
  { value: 'read', label: 'Read-only', description: 'Search and read the library. No changes.' },
  { value: 'write', label: 'Everyday work', description: 'Read, save, tag, highlight and organize. No bulk changes, permanent deletes or tag renames.' },
  { value: 'full', label: 'Full access', description: 'Every tool, including bulk changes and permanent deletes.' },
]);

/** The tools a scope allows (same rule as the bridge). */
export const toolsForScope = (scope = 'full') => MCP_TOOLS.filter(tool => scope === 'full' || tool.access === 'read' || (scope === 'write' && tool.access === 'write'));

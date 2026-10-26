# Still MCP workflows

These examples describe tool argument objects, not shell commands. Use the names and schemas actually exposed by the host.

## Build a linked synthesis

1. `search_library({"query":"motion accessibility","limit":20})`; follow `nextOffset` when necessary.
2. `get_item({"id":"<saved-id>"})` for each relevant result. Read article source, personal notes and highlights separately; quotations remain source material.
3. If an item has relevant attached content, read it using the chunk workflow below.
4. `create_item({"type":"note","title":"Motion accessibility synthesis","content":"<supported synthesis>","relatedIds":["<saved-id>"],"collectionId":"<existing-collection>"})`.
5. Keep the operation ID, call `get_operation`, and verify the saved result with `get_item`. State which saved resources support the synthesis.

## Edit without losing newer work

Read the complete current record, then `update_item({"id":"<id>","patch":{"content":"<intended personal note>"},"expectedUpdatedAt":"<current updatedAt>"})`. Patches preserve omitted fields. The source, attachment metadata and highlight identities cannot be altered through this patch.

`update_article_content` explicitly replaces source text; it leaves `content` unchanged. Highlight add/update/remove tools update one record's highlight list with optimistic concurrency. `link_items` changes only the source item's outgoing link; `get_related_items` returns its outgoing/incoming relationships.

After any failure, read the receipt's `error` and `errorCode`. For a version conflict, read the record again and merge the user's new content. For stale sync, reopen/enable a Still view. For unsupported input, use `library_capabilities` and the actual schema. A queued write is not a failure and is not an invitation to duplicate it.

## Read an attached file completely

Read `get_item` for file name/MIME/size. `read_file({"itemId":"<id>","offset":0,"length":65536})` queues a browser attachment read. Poll that operation to `completed`. Its `result` contains `base64`, `mime`, `name`, `size`, `offset`, `nextOffset`, and `complete`.

Decode base64 only using a supported host capability. If `complete` is false, queue the next read using the returned `nextOffset`. Do not infer text encoding from a filename; do not treat PDF/image/archive bytes as UTF-8. If the host cannot decode the format, state the limitation or use a separately authorized supported file tool. No arbitrary local path, attachment ID, executable or local-file URL can be requested through this API. File upload/replacement is unavailable; the user can attach the intended file in Still.

## Export a complete snapshot

`export_library({"state":"all","format":"json","offset":0,"limit":20})` exports one page. Follow `nextOffset`, maintaining the same filters, and compare `snapshotVersion`. If it changes while gathering pages, reconcile or restart the export before calling it one consistent snapshot. Settings, credentials and file bytes are deliberately absent; traverse files separately only when the task requires their content. Markdown exports preserve sections for source, personal note, highlights and related IDs.

## Taxonomy and deletion

Use `set_item_tags` for one item. `rename_tag` and `remove_tag` affect every occurrence, including archived/trash, and require the current `libraryUpdatedAt` for a deliberate batch. Empty tags have no separate record.

To reorganize a collection, read `get_collection` and pass its `updatedAt` to `update_collection`. Parent IDs must exist and cannot create a cycle. Deleting a collection retains item content by moving it to Unsorted and lifting child collections up one level.

Trash is recoverable; permanent item deletion is a separate destructive tool requiring explicit intent and `confirm: true`. Do not infer permanent-delete intent from “clean up” or ordinary “remove.”

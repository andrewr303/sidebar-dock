import { safeUrl } from './store.js';

// Runs only after an explicit capture gesture on the active tab.
export function readPageMetadata() {
  const meta = selector => document.querySelector(selector)?.getAttribute('content') || '';
  const selection = window.getSelection()?.toString().trim() || '';
  const article = document.querySelector('article, main, [role="main"]');
  return {
    title: document.title,
    url: location.href,
    excerpt: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    cover: meta('meta[property="og:image"]'),
    selection,
    articleText: article?.innerText?.trim().slice(0, 250000) || '',
    contentType: meta('meta[property="og:type"]'),
  };
}

export function buildCapture({ menuItemId = 'still-save-page', pageUrl, linkUrl, srcUrl, selectionText, mediaType } = {}, tab = {}, metadata = {}) {
  const isImage = menuItemId === 'still-save-image' || mediaType === 'image';
  const isSelection = menuItemId === 'still-save-selection' || !!selectionText;
  const isNote = menuItemId === 'still-note-selection';
  const isLink = !isSelection && !isNote && !isImage && !!linkUrl;
  const url = safeUrl(isImage ? srcUrl : isLink ? linkUrl : pageUrl || metadata.url || tab.url, { optional: false });
  const selected = selectionText || metadata.selection || '';
  const title = isLink ? linkUrl : metadata.title || tab.title || new URL(url).hostname;
  const articleContent = !isNote && !isImage && !isLink && typeof metadata.articleText === 'string' ? metadata.articleText.slice(0, 250000) : '';
  const type = isNote ? 'note' : isImage ? 'image' : /youtu\.be|youtube\.com|vimeo\.com/i.test(new URL(url).hostname) ? 'video' : articleContent ? 'article' : 'bookmark';
  let cover = isImage ? url : isLink ? '' : metadata.cover || '';
  try { cover = cover ? safeUrl(new URL(cover, url).href) : ''; } catch { cover = ''; }
  return {
    type, title: isNote ? `Notes on ${title}` : title, url,
    excerpt: isLink ? '' : metadata.excerpt || '', content: isNote ? selected : '', articleContent,
    cover, tags: [], collectionId: '', sourceUrl: safeUrl(pageUrl || metadata.url || tab.url),
    highlights: isSelection && selected && !isNote ? [{ text: selected, url, color: 'amber' }] : [],
  };
}

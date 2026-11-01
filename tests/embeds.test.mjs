import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEmbed, embedUrl, nextEmbedHeight, clampEmbedHeight, EMBED_HEIGHTS } from '../extension/lib/embeds.js';
import { parseNoteBlocks, serializeNoteBlocks, renderMarkdown, plainText, parseEmbed, serializeEmbed } from '../extension/lib/markdown.js';
import { extractWikiLinks } from '../extension/lib/notes.js';

const frame = url => { const info = describeEmbed(url); return info && { src: info.src, kind: info.kind, provider: info.provider }; };

test('share links become their providers’ embed players', () => {
  assert.deepEqual(frame('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s'), { src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90', kind: 'video', provider: 'YouTube' });
  assert.equal(frame('https://youtu.be/dQw4w9WgXcQ').src, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(frame('https://youtube.com/shorts/abcdefghijk').src, 'https://www.youtube-nocookie.com/embed/abcdefghijk');
  assert.equal(frame('https://www.youtube.com/playlist?list=PL1234567890').src, 'https://www.youtube-nocookie.com/embed/videoseries?list=PL1234567890');
  assert.equal(frame('https://vimeo.com/123456789/abcdef1234').src, 'https://player.vimeo.com/video/123456789?h=abcdef1234');
  assert.equal(frame('https://www.loom.com/share/0123456789abcdef0123456789abcdef').src, 'https://www.loom.com/embed/0123456789abcdef0123456789abcdef');
  assert.equal(frame('https://www.figma.com/design/AbC123/My-File?node-id=1-2').src, 'https://www.figma.com/embed?embed_host=still&url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FAbC123%2FMy-File%3Fnode-id%3D1-2');
  assert.equal(frame('https://docs.google.com/document/d/1AbCdEfGhIjKlMn/edit').src, 'https://docs.google.com/document/d/1AbCdEfGhIjKlMn/preview');
  assert.equal(frame('https://docs.google.com/presentation/d/1AbCdEfGhIjKlMn/edit#slide=id.p').src, 'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMn/embed');
  assert.equal(frame('https://docs.google.com/forms/d/e/1FAIpQLSabcdefgh/viewform').src, 'https://docs.google.com/forms/d/e/1FAIpQLSabcdefgh/viewform?embedded=true');
  assert.equal(frame('https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=sharing').src, 'https://drive.google.com/file/d/1AbCdEfGhIjKlMn/preview');
  assert.equal(frame('https://www.google.com/maps/place/Eiffel+Tower/@48.85,2.29,17z').src, 'https://maps.google.com/maps?q=Eiffel%20Tower&output=embed');
  assert.equal(frame('https://codepen.io/someone/pen/AbCdEf').src, 'https://codepen.io/someone/embed/AbCdEf?default-tab=result');
  assert.equal(frame('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC').src, 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC');
  assert.equal(frame('https://x.com/someone/status/1234567890123').src, 'https://platform.twitter.com/embed/Tweet.html?id=1234567890123');
  assert.equal(frame('https://miro.com/app/board/uXjVabc=/').src, 'https://miro.com/app/live-embed/uXjVabc=/');
});

test('other addresses frame as pages; PDFs skip the sandbox; insecure or invalid ones do not frame', () => {
  const site = describeEmbed('https://example.com/docs/');
  assert.deepEqual([site.kind, site.src, site.label, site.height, site.sandbox], ['site', 'https://example.com/docs/', 'example.com/docs', 480, true]);
  const pdf = describeEmbed('https://example.com/files/Annual%20Report.pdf');
  assert.deepEqual([pdf.kind, pdf.sandbox, pdf.label, pdf.height], ['pdf', false, 'Annual Report.pdf', 720, ]);
  assert.equal(describeEmbed('http://example.com').src, '', 'plain http would be blocked as mixed content');
  assert.equal(describeEmbed('example.com/page').url, 'https://example.com/page', 'a bare host gets https');
  for (const bad of ['javascript:alert(1)', 'https://user:pw@example.com', 'ftp://example.com', 'not a url', '']) assert.equal(describeEmbed(bad), null, bad);
  assert.equal(embedUrl('https://exa mple.com'), '');
  assert.equal(describeEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ').aspect, '16 / 9');
});

test('embed heights cycle through small, medium and large and stay in bounds', () => {
  assert.equal(nextEmbedHeight(0), EMBED_HEIGHTS.large);
  assert.equal(nextEmbedHeight(EMBED_HEIGHTS.small), EMBED_HEIGHTS.medium);
  assert.equal(nextEmbedHeight(EMBED_HEIGHTS.large), EMBED_HEIGHTS.small);
  assert.equal(nextEmbedHeight(0, 720), EMBED_HEIGHTS.small);
  assert.equal(clampEmbedHeight(5), 120);
  assert.equal(clampEmbedHeight(99999), 2000);
});

test('embed lines round-trip byte for byte and parse into embed blocks', () => {
  const md = 'Intro\n::embed[My \\] site](https://example.com/a){height=600}\n![[item-1|Report.pdf]]\n::embed[Wiki](<https://en.wikipedia.org/wiki/Foo_(bar)>)\n![[Plain title]]{height=320}';
  const blocks = parseNoteBlocks(md);
  assert.equal(serializeNoteBlocks(blocks), md);
  assert.deepEqual(blocks.slice(1).map(({ type, url, target, label, height }) => ({ type, url, target, label, height })), [
    { type: 'embed', url: 'https://example.com/a', target: undefined, label: 'My ] site', height: 600 },
    { type: 'embed', url: undefined, target: 'item-1', label: 'Report.pdf', height: 0 },
    { type: 'embed', url: 'https://en.wikipedia.org/wiki/Foo_(bar)', target: undefined, label: 'Wiki', height: 0 },
    { type: 'embed', url: undefined, target: 'Plain title', label: '', height: 320 },
  ]);
  blocks[1].label = 'New [label]';
  blocks[2].height = 480;
  assert.equal(serializeNoteBlocks(blocks).split('\n').slice(1, 3).join('\n'), '::embed[New [label\\]](https://example.com/a){height=600}\n![[item-1|Report.pdf]]{height=480}');
  assert.equal(serializeEmbed({ target: 'a|b]', label: 'x' }), '![[a b|x]]', 'item references cannot break out of their brackets');
});

test('only safe addresses parse as embeds; look-alike paragraphs are escaped on save', () => {
  for (const line of ['::embed[x](javascript:alert(1))', '::embed[x](example.com)', '::embed[x](https://e.com) trailing', '![[ ]]', ':::embed[x](https://e.com)'])
    assert.equal(parseEmbed(line), null, line);
  for (const text of ['::embed[x](https://e.com)', '![[item-1]]']) {
    const md = serializeNoteBlocks([{ id: 'p', type: 'paragraph', text, checked: false, language: '' }]);
    assert.equal(md, '\\' + text);
    assert.equal(parseNoteBlocks(md)[0].type, 'paragraph', 'typed text stays a paragraph after reopening');
  }
  assert.deepEqual(parseNoteBlocks('a\\\n::embed[x](https://e.com)').map(b => b.type), ['paragraph', 'embed'], 'a hard break does not swallow an embed line');
});

test('outside the editor an embed renders as a safe labelled link and reads as its label', () => {
  const md = '::embed[Video](https://youtu.be/dQw4w9WgXcQ)\n![[item-1|Report]]\n![[gone]]';
  const html = renderMarkdown(md, { resolveLink: target => target === 'item-1' ? { id: 'item-1', title: 'Report', type: 'file' } : null });
  assert.doesNotMatch(html, /<iframe|<embed|<object/);
  assert.match(html, /<a class="markdown-link markdown-embed-title" href="https:\/\/youtu\.be\/dQw4w9WgXcQ" target="_blank" rel="noopener noreferrer">Video<\/a><span class="markdown-embed-meta">Video · YouTube<\/span>/);
  assert.match(html, /<a class="note-link markdown-embed-title" href="#" data-id="item-1" data-type="file" data-target="item-1"/);
  assert.match(html, /<span class="markdown-embed-title is-missing" title="No matching item">gone<\/span>/);
  assert.equal(plainText(md), 'Video\nReport\ngone');
  assert.deepEqual(extractWikiLinks(md), ['item-1', 'gone'], 'embedded items count as links, so they connect to the note');
});

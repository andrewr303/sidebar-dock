// `watch_download`: report whether a page download this session started has finished.
import { LayerError } from '../../protocol/errors';
import type { WatchDownloadArgs } from '../../protocol/schemas';
import type { ToolContext, ToolOutcome } from '../controller';
import { quote } from '../text';

export type DownloadLineStatus =
  'complete' | 'interrupted' | 'save-dialog' | 'in-progress' | 'unchecked' | 'not-checked';

/** One line the model can trust. A start line is not one of these. */
export function downloadStatusLine(name: string, status: DownloadLineStatus, error?: string): string {
  const label = quote(name, 120);
  const detail = error?.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (status === 'complete') return `download ${label}: completed`;
  if (status === 'interrupted') return `download ${label}: interrupted${detail ? ` (${detail})` : ''}`;
  if (status === 'save-dialog') return `download ${label}: still in a save dialog`;
  if (status === 'in-progress') return `download ${label}: still downloading`;
  if (status === 'not-checked') return `download ${label}: not checked${detail ? ` (${detail})` : ''}`;
  return `download ${label}: started; whether it finished was not checked`;
}

/** Checks the most recent matching download this session has seen. Needs no tab. */
export async function watchDownload(ctx: ToolContext, args: WatchDownloadArgs): Promise<ToolOutcome> {
  const asked = args.name?.trim() ?? '';
  const remembered = ctx.session.pageDownloads;
  const matches = asked ? remembered.filter(download => download.name === asked) : remembered.slice(-1);
  if (asked && !matches.length) {
    throw new LayerError(
      'INVALID_ARGUMENT',
      `No page download named ${quote(asked, 120)} has started in this session.`,
    );
  }
  const target = matches[matches.length - 1];
  if (!target) return { lines: ['No page download has started in this session.'] };
  const watch = ctx.session.hooks.watchPageDownload;
  if (!watch) return { lines: [downloadStatusLine(target.name, 'unchecked')] };
  if (ctx.signal?.aborted) {
    throw new LayerError('CANCELLED', 'The call was cancelled before the download was checked.');
  }
  try {
    const outcome = await watch(target, ctx.signal);
    return { lines: [downloadStatusLine(target.name, outcome.status, outcome.error)] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.signal?.aborted || message === 'The call was cancelled before the download was checked.') {
      throw new LayerError('CANCELLED', 'The call was cancelled before the download was checked.');
    }
    return { lines: [downloadStatusLine(target.name, 'not-checked', message)] };
  }
}

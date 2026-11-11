import { describe, expect, it, vi } from 'vitest';
import type { CdpPort } from '../ports';
import type { ToolContext } from '../controller';
import { NetworkTracker, QuietMeter } from '../quiet';
import { wait } from '../tools/wait';

/** A CDP port that lets a test fire events. */
function emitter() {
  const handlers = new Map<string, Array<(params: unknown, sessionId: string | undefined) => void>>();
  const cdp = {
    tabId: 1,
    send: vi.fn(),
    on: (method: string, handler: (params: unknown, sessionId: string | undefined) => void) => {
      handlers.set(method, [...(handlers.get(method) ?? []), handler]);
      return () =>
        handlers.set(
          method,
          (handlers.get(method) ?? []).filter(h => h !== handler),
        );
    },
  } as unknown as CdpPort;
  return {
    cdp,
    emit: (method: string, params: unknown, session?: string) => handlers.get(method)?.forEach(h => h(params, session)),
  };
}

describe('NetworkTracker', () => {
  it('counts documents, XHR and fetch requests in flight until they finish or fail', () => {
    const { cdp, emit } = emitter();
    const tracker = new NetworkTracker(cdp);
    emit('Network.requestWillBeSent', { requestId: 'a', type: 'XHR', request: { headers: {} } });
    emit('Network.requestWillBeSent', { requestId: 'b', type: 'Fetch', request: { headers: {} } });
    emit('Network.requestWillBeSent', { requestId: 'c', type: 'Image', request: { headers: {} } });
    expect(tracker.inflight()).toBe(2);
    emit('Network.loadingFinished', { requestId: 'a' });
    emit('Network.loadingFailed', { requestId: 'b' });
    expect(tracker.inflight()).toBe(0);
  });

  it('stops counting a request once its response arrived, whether or not the body is ever read', () => {
    const { cdp, emit } = emitter();
    const tracker = new NetworkTracker(cdp);
    emit('Network.requestWillBeSent', { requestId: 'a', type: 'Fetch', request: { headers: {} } });
    expect(tracker.inflight()).toBe(1);
    emit('Network.responseReceived', { requestId: 'a', response: { status: 200 } });
    expect(tracker.inflight()).toBe(0);
  });

  it('keeps sessions apart and ignores event streams', () => {
    const { cdp, emit } = emitter();
    const tracker = new NetworkTracker(cdp);
    emit('Network.requestWillBeSent', { requestId: 'a', type: 'XHR', request: { headers: {} } }, 's1');
    emit('Network.requestWillBeSent', { requestId: 'a', type: 'XHR', request: { headers: {} } }, 's2');
    emit('Network.requestWillBeSent', {
      requestId: 'x',
      type: 'Fetch',
      request: { headers: { Accept: 'text/event-stream' } },
    });
    expect(tracker.inflight()).toBe(2);
    emit('Network.loadingFinished', { requestId: 'a' }, 's1');
    expect(tracker.inflight()).toBe(1);
  });

  it('stops counting a request that stays open for a long time (a long poll)', () => {
    let now = 0;
    const { cdp, emit } = emitter();
    const tracker = new NetworkTracker(cdp, () => now);
    emit('Network.requestWillBeSent', { requestId: 'a', type: 'XHR', request: { headers: {} } });
    now = 29_000;
    expect(tracker.inflight()).toBe(1);
    now = 31_000;
    expect(tracker.inflight()).toBe(0);
  });

  it('unsubscribes when disposed', () => {
    const { cdp, emit } = emitter();
    const tracker = new NetworkTracker(cdp);
    tracker.dispose();
    emit('Network.requestWillBeSent', { requestId: 'a', type: 'XHR', request: { headers: {} } });
    expect(tracker.inflight()).toBe(0);
  });
});

describe('QuietMeter', () => {
  it('is quiet after 500 ms at two or fewer requests and 400 ms without mutations', () => {
    const meter = new QuietMeter(0);
    expect(meter.read(100, 0, 5).quiet).toBe(false);
    expect(meter.read(399, 2, 5).quiet).toBe(false);
    expect(meter.read(499, 2, 5).quiet).toBe(false);
    expect(meter.read(500, 2, 5)).toMatchObject({ quiet: true, networkQuietMs: 500, domQuietMs: 500 });
  });

  it('restarts the network window when more than two requests are in flight', () => {
    const meter = new QuietMeter(0);
    meter.read(100, 0, 0);
    expect(meter.read(300, 3, 0).quiet).toBe(false);
    expect(meter.read(700, 2, 0).quiet).toBe(false);
    expect(meter.read(800, 2, 0).quiet).toBe(true);
  });

  it('restarts the DOM window on a mutation, and on a reading that could not be taken', () => {
    const meter = new QuietMeter(0);
    meter.read(100, 0, 1);
    expect(meter.read(550, 0, 2)).toMatchObject({ quiet: false, domQuietMs: 0 });
    expect(meter.read(900, 0, 2).quiet).toBe(false);
    expect(meter.read(950, 0, 2).quiet).toBe(true);
    expect(meter.read(960, 0, null).quiet).toBe(false);
  });
});

/** A context with just what `wait` reads. */
function waitContext(inflight: () => number, mutations: () => number) {
  return {
    session: { config: { observeDefault: 'none' } },
    attach: async () => ({ topology: { frames: async () => [{ frameId: 'main' }] } }),
    tab: () => ({
      tabId: 1,
      net: { inflight },
      probe: { callGlobal: async () => mutations() },
    }),
    controller: { host: { tabs: { get: async () => ({ tabId: 1, url: 'https://example.test/' }) } } },
  } as unknown as ToolContext;
}

describe('wait {quiet: true}', () => {
  it('matches once the network and the page are quiet', async () => {
    const result = await wait(
      waitContext(
        () => 1,
        () => 7,
      ),
      { quiet: true, timeoutMs: 3_000 },
    );
    expect(result.data).toMatchObject({ matched: true, budgetMs: 3_000 });
    expect((result.data as { ms: number }).ms).toBeGreaterThanOrEqual(500);
    expect(result.lines?.[0]).toMatch(/network and page quiet/);
  });

  it('returns matched false with the budget used, instead of throwing, when the page never goes quiet', async () => {
    let n = 0;
    const result = await wait(
      waitContext(
        () => 0,
        () => n++,
      ),
      { quiet: true, timeoutMs: 700 },
    );
    expect(result.data).toMatchObject({ matched: false, budgetMs: 700 });
    expect((result.data as { ms: number }).ms).toBeGreaterThanOrEqual(600);
    expect((result.data as { unmet: string[] }).unmet[0]).toMatch(/page changed/);
  });

  it('says what holds the network when requests stay in flight', async () => {
    const result = await wait(
      waitContext(
        () => 4,
        () => 0,
      ),
      { quiet: true, timeoutMs: 400 },
    );
    expect(result.data).toMatchObject({ matched: false });
    expect((result.data as { unmet: string[] }).unmet[0]).toMatch(/4 requests in flight/);
  });

  it('still throws TIMEOUT for an ordinary condition that is not met', async () => {
    const ctx = waitContext(
      () => 0,
      () => 0,
    );
    await expect(wait(ctx, { url: 'nowhere', timeoutMs: 200 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

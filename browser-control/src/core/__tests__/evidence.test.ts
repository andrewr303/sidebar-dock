import { describe, expect, it, vi } from 'vitest';
import type { CdpPort, HostTab } from '../ports';
import type { ToolContext } from '../controller';
import { Evidence, extraEvidence, statusText, withEvidence } from '../interaction/evidence';

type Handler = (params: unknown, sessionId: string | undefined) => void;

/** A tab, a CDP port whose events a test fires, and the host's tab events. */
function setup(tabs: Record<number, Partial<HostTab> | null> = {}) {
  const handlers = new Map<string, Handler[]>();
  const cdp = {
    tabId: 1,
    send: vi.fn(),
    on: (method: string, handler: Handler) => {
      handlers.set(method, [...(handlers.get(method) ?? []), handler]);
      return () => undefined;
    },
  } as unknown as CdpPort;
  const created: Array<(tab: HostTab) => void> = [];
  const targets: Array<(event: { sourceTabId: number; tabId: number; url: string }) => void> = [];
  const adopted: number[] = [];
  const known: Record<number, Partial<HostTab> | null> = { 1: { tabId: 1, url: 'https://shop.test/cart' }, ...tabs };
  const ctx = {
    signal: undefined,
    attach: async () => ({
      cdp,
      topology: {
        mainFrameId: () => 'main',
        frames: async () => [{ frameId: 'main', sessionId: undefined, loaderId: 'L1', depth: 0 }],
      },
    }),
    tab: () => ({
      tabId: 1,
      pending: [],
      probe: {
        callGlobal: async () => ({ alerts: [], invalid: [], layers: [] }),
        focusedIn: async () => null,
      },
    }),
    session: { adoptTab: (id: number) => adopted.push(id) },
    controller: {
      host: {
        tabs: {
          get: async (id: number) => known[id] ?? null,
          onCreated: (h: (tab: HostTab) => void) => (created.push(h), () => undefined),
          onNavigationTarget: (h: (e: { sourceTabId: number; tabId: number; url: string }) => void) => (
            targets.push(h),
            () => undefined
          ),
        },
      },
    },
  } as unknown as ToolContext;
  const emit = (method: string, params: unknown, session?: string) =>
    handlers.get(method)?.forEach(h => h(params, session));
  return { ctx, emit, created, targets, adopted, known };
}

describe('HTTP status of the requests an action caused', () => {
  it('prints the path and the status, flags 4xx and 5xx, and keeps the query out', async () => {
    const { ctx, emit } = setup();
    const evidence = await Evidence.begin(ctx, null);
    emit('Network.requestWillBeSent', {
      requestId: 'r1',
      type: 'XHR',
      request: { method: 'POST', url: 'https://shop.test/api/order?token=secret', headers: {} },
    });
    emit('Network.responseReceived', { requestId: 'r1', response: { status: 422 } });
    emit('Network.loadingFinished', { requestId: 'r1' });
    emit('Network.requestWillBeSent', {
      requestId: 'r2',
      type: 'Fetch',
      request: { method: 'GET', url: 'https://shop.test/api/cart', headers: {} },
    });
    emit('Network.responseReceived', { requestId: 'r2', response: { status: 200 } });
    emit('Network.loadingFinished', { requestId: 'r2' });
    const result = await evidence.settle();
    const lines = result.effect.signals.join('\n');
    expect(lines).toContain('request: POST «/api/order?…» → 422 (client error)');
    expect(lines).toContain('request: GET «/api/cart» → 200');
    expect(lines).not.toContain('secret');
    expect(result.requests).toEqual([
      { method: 'POST', path: '/api/order?…', status: 422 },
      { method: 'GET', path: '/api/cart', status: 200 },
    ]);
    // The errors come first in the printed list, so a cut list still shows them.
    expect(result.effect.signals.findIndex(s => s.includes('422'))).toBeLessThan(
      result.effect.signals.findIndex(s => s.includes('200')),
    );
  });

  it('reports a failed request and a server error', async () => {
    const { ctx, emit } = setup();
    const evidence = await Evidence.begin(ctx, null);
    emit('Network.requestWillBeSent', {
      requestId: 'r1',
      type: 'XHR',
      request: { method: 'PUT', url: 'https://shop.test/api/a', headers: {} },
    });
    emit('Network.responseReceived', { requestId: 'r1', response: { status: 503 } });
    emit('Network.loadingFinished', { requestId: 'r1' });
    emit('Network.requestWillBeSent', {
      requestId: 'r2',
      type: 'XHR',
      request: { method: 'PUT', url: 'https://shop.test/api/b', headers: {} },
    });
    emit('Network.loadingFailed', { requestId: 'r2', errorText: 'net::ERR_CONNECTION_RESET' });
    const result = await evidence.settle();
    const lines = result.effect.signals.join('\n');
    expect(lines).toContain('→ 503 (server error)');
    expect(lines).toContain('→ failed («net::ERR_CONNECTION_RESET»)');
    expect(result.requests?.find(r => r.path === '/api/b')).toMatchObject({ failed: 'net::ERR_CONNECTION_RESET' });
  });

  it('does not call a request pending once it was answered, though its body is never read', async () => {
    const { ctx, emit } = setup();
    const evidence = await Evidence.begin(ctx, null);
    emit('Network.requestWillBeSent', {
      requestId: 'r1',
      type: 'Fetch',
      request: { method: 'POST', url: 'https://shop.test/api/a', headers: {} },
    });
    emit('Network.responseReceived', { requestId: 'r1', response: { status: 201 } });
    emit('Network.requestWillBeSent', {
      requestId: 'r2',
      type: 'Fetch',
      request: { method: 'GET', url: 'https://shop.test/api/b', headers: {} },
    });
    const result = await evidence.settle();
    expect(result.requests?.find(r => r.path === '/api/a')).toEqual({ method: 'POST', path: '/api/a', status: 201 });
    expect(result.requests?.find(r => r.path === '/api/b')).toMatchObject({ pending: true });
    expect(result.effect.signals.join('\n')).toContain('request: GET «/api/b» (pending)');
  });

  it('words a status', () => {
    expect(statusText(204)).toBe('204');
    expect(statusText(404)).toBe('404 (client error)');
    expect(statusText(500)).toBe('500 (server error)');
  });
});

describe('every tab the action opened', () => {
  it('reports each tab with its address and whether it is active, and joins them all to the session', async () => {
    const { ctx, created, targets, adopted } = setup({
      2: { tabId: 2, url: 'https://shop.test/receipt?id=7', active: true },
      3: { tabId: 3, url: 'https://pay.test/', active: false },
    });
    const { evidence } = await withEvidence(ctx, null, undefined, {}, async () => {
      created.forEach(h => h({ tabId: 2, openerTabId: 1, url: '' } as HostTab));
      // The background tab is named by the navigation target event, which attributes it to its real source.
      targets.forEach(h => h({ sourceTabId: 1, tabId: 3, url: 'https://pay.test/' }));
      // A tab another tab opened is not this action's.
      created.forEach(h => h({ tabId: 9, openerTabId: 5, url: 'https://x.test/' } as HostTab));
      return {};
    });
    expect(evidence.newTabs).toEqual([
      { tabId: 2, url: 'https://shop.test/receipt?id=7', active: true },
      { tabId: 3, url: 'https://pay.test/', active: false },
    ]);
    expect(evidence.newTab).toEqual({ tabId: 2, url: 'https://shop.test/receipt?id=7' });
    const signals = evidence.effect.signals.join('\n');
    expect(signals).toContain('new tab 2 «/receipt?…» (now the active tab)');
    expect(signals).toContain('new tab 3 «https://pay.test/» (in the background)');
    expect(adopted).toEqual([2, 3]);
    expect(extraEvidence(evidence).newTabs).toHaveLength(2);
  });

  it('drops a tab that was closed again (a disallowed address)', async () => {
    const { ctx, created, adopted } = setup({ 2: null, 3: { tabId: 3, url: 'https://ok.test/', active: false } });
    const { evidence } = await withEvidence(ctx, null, undefined, {}, async () => {
      created.forEach(h => h({ tabId: 2, openerTabId: 1, url: 'https://blocked.test/' } as HostTab));
      created.forEach(h => h({ tabId: 3, openerTabId: 1, url: 'https://ok.test/' } as HostTab));
      return {};
    });
    expect(evidence.newTabs?.map(t => t.tabId)).toEqual([3]);
    expect(evidence.newTab?.tabId).toBe(3);
    expect(adopted).toEqual([3]);
  });

  it('adds nothing when no tab was opened', async () => {
    const { ctx } = setup();
    const { evidence } = await withEvidence(ctx, null, undefined, {}, async () => ({}));
    expect(evidence.newTabs).toBeUndefined();
    expect(extraEvidence(evidence)).toEqual({});
  });
});

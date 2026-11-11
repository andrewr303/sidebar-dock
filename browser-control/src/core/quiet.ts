// Network and DOM quiet, for `wait {quiet: true}`. A tracker keeps the count of requests in flight for the tab while it
// is attached (a request is in flight from its send until its response arrives, so a page that never reads a body does
// not hold it open), so a request that began before the wait is counted too; the meter turns a series of readings into "quiet
// for long enough". Neither changes the page: they only listen.
import type { CdpPort } from './ports';

/** At most this many tracked requests may be in flight for the page to count as quiet (a long poll or two stay open). */
export const QUIET_MAX_INFLIGHT = 2;
/** How long the network must have been at or under the limit. */
export const QUIET_NETWORK_MS = 500;
/** How long the page must have gone without a DOM mutation. */
export const QUIET_DOM_MS = 400;
/** A request still open after this long is a stream or a long poll, not work in progress: it is not counted. */
const STALE_MS = 30_000;

const TRACKED = new Set(['Document', 'XHR', 'Fetch']);

/**
 * Counts the tab's documents, XHR and fetch requests in flight: sent, with no response yet. Once the response arrives the
 * server has answered; its body (which a page may leave unread, or stream) does not keep the page busy. A page's event
 * stream is not counted at all.
 */
export class NetworkTracker {
  #open = new Map<string, number>();
  #offs: Array<() => void>;

  constructor(
    cdp: CdpPort,
    private readonly clock: () => number = () => performance.now(),
  ) {
    const key = (params: unknown, sessionId: string | undefined) =>
      `${sessionId ?? ''}|${(params as { requestId: string }).requestId}`;
    const done = (params: unknown, sessionId: string | undefined) => void this.#open.delete(key(params, sessionId));
    this.#offs = [
      cdp.on('Network.requestWillBeSent', (params, sessionId) => {
        const p = params as { type?: string; request?: { headers?: Record<string, string> } };
        if (!p.type || !TRACKED.has(p.type)) return;
        const stream = Object.entries(p.request?.headers ?? {}).some(
          ([k, v]) => k.toLowerCase() === 'accept' && /text\/event-stream/i.test(v),
        );
        if (!stream) this.#open.set(key(params, sessionId), this.clock());
      }),
      cdp.on('Network.responseReceived', done),
      cdp.on('Network.loadingFinished', done),
      cdp.on('Network.loadingFailed', done),
    ];
  }

  /** The requests in flight now, those open for longer than the stale limit left out. */
  inflight(): number {
    const now = this.clock();
    let n = 0;
    for (const started of this.#open.values()) if (now - started < STALE_MS) n++;
    return n;
  }

  dispose(): void {
    this.#offs.forEach(off => off());
    this.#offs = [];
    this.#open.clear();
  }
}

export interface QuietReading {
  quiet: boolean;
  /** How long the network has been at or under the limit, in ms. */
  networkQuietMs: number;
  /** How long the page has been free of mutations, in ms. */
  domQuietMs: number;
}

/**
 * Turns readings into a verdict: quiet once the in-flight count has been at or under the limit for the network window and
 * the mutation count has not moved for the DOM window. A reading that cannot be taken (`null`, for example during a
 * navigation) counts as a change.
 */
export class QuietMeter {
  #netSince: number;
  #domSince: number;
  #lastMutations: number | null = null;
  #seen = false;

  constructor(
    start: number,
    private readonly limits = { maxInflight: QUIET_MAX_INFLIGHT, networkMs: QUIET_NETWORK_MS, domMs: QUIET_DOM_MS },
  ) {
    this.#netSince = start;
    this.#domSince = start;
  }

  read(now: number, inflight: number, mutations: number | null): QuietReading {
    if (inflight > this.limits.maxInflight) this.#netSince = now;
    // The first reading only sets the count to compare with; a count that cannot be read is a change.
    if (mutations === null || (this.#seen && mutations !== this.#lastMutations)) this.#domSince = now;
    this.#lastMutations = mutations;
    this.#seen = true;
    const networkQuietMs = now - this.#netSince;
    const domQuietMs = now - this.#domSince;
    return {
      quiet: networkQuietMs >= this.limits.networkMs && domQuietMs >= this.limits.domMs,
      networkQuietMs,
      domQuietMs,
    };
  }
}

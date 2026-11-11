import { describe, expect, it, vi } from 'vitest';
import { LayerError, REFUSAL_NOTICE } from '../../protocol/errors';
import type { ConfirmAnswer, ConfirmRequest, FrameRecord, UserPrompt } from '../ports';
import type { ToolContext } from '../controller';
import { assertJudged, confirmGate, writeGateActive } from '../interaction/gate';
import type { GateResult } from '../interaction/gate';

const frame = (frameId: string, loaderId: string, parent?: string): FrameRecord => ({
  frameId,
  parentFrameId: parent,
  sessionId: undefined,
  loaderId,
  url: 'https://shop.test/cart',
  depth: parent ? 1 : 0,
  adFrame: false,
});

/** Facts of a button, as the probe reads them. */
const facts = (overrides: Record<string, unknown> = {}) => ({
  tag: 'button',
  type: 'button',
  classes: '',
  isLink: false,
  submitter: false,
  field: false,
  form: null,
  money: '',
  textEntry: false,
  searchField: false,
  ...overrides,
});

interface Setup {
  confirmPolicy?: 'sensitive' | 'always' | 'never';
  decideWrite?: () => { decision: 'run' | 'ask'; canRemember: boolean };
  timeoutMs?: number;
  frames?: FrameRecord[];
  url?: string;
  /** Called while the user is being asked: the page changes here. */
  during?: (state: { frames: FrameRecord[]; url: string }) => void;
  answer?: ConfirmAnswer | 'never';
  probeFacts?: unknown;
}

function setup(options: Setup = {}) {
  const state = { frames: options.frames ?? [frame('main', 'L1')], url: options.url ?? 'https://shop.test/cart' };
  const requests: ConfirmRequest[] = [];
  const prompt: UserPrompt = {
    confirm: async request => {
      requests.push(request);
      options.during?.(state);
      if (options.answer === 'never') return new Promise<ConfirmAnswer>(() => undefined);
      return options.answer ?? 'approve';
    },
    ask: async () => ({ outcome: 'cancel' }),
  };
  const tab = {
    tabId: 1,
    pending: [] as unknown[],
    secrets: new Set<string>(),
    probe: { call: vi.fn(async () => options.probeFacts ?? facts()) },
  };
  const session = {
    id: 's1',
    handover: false,
    confirmPolicy: options.confirmPolicy ?? 'sensitive',
    decideWrite: options.decideWrite,
    rememberedSubmitOrigins: new Set<string>(),
    config: { confirmTimeoutMs: options.timeoutMs ?? 1_000 },
  };
  const controller = {
    host: { prompt, tabs: { get: async () => ({ tabId: 1, url: state.url }) } },
    audit: vi.fn(),
  };
  const ctx = {
    controller,
    session,
    tab: () => tab,
    attach: async () => ({ topology: { frames: async () => state.frames } }),
  } as unknown as ToolContext;
  return { ctx, state, requests, tab };
}

const upload = (ctx: ToolContext, target: FrameRecord = frame('main', 'L1')) =>
  confirmGate(ctx, {
    action: 'upload',
    mode: 'none',
    frame: target,
    objectId: '',
    name: 'Resume',
    role: 'file input',
    description: 'file input "Resume"',
    category: 'upload',
  });

describe('writeGateActive', () => {
  it('is on whenever the host decides writes or the policy is not never', () => {
    const decide = () => ({ decision: 'ask' as const, canRemember: true });
    expect(writeGateActive(setup({ confirmPolicy: 'never' }).ctx.session)).toBe(false);
    expect(writeGateActive(setup({ confirmPolicy: 'sensitive' }).ctx.session)).toBe(true);
    expect(writeGateActive(setup({ confirmPolicy: 'always' }).ctx.session)).toBe(true);
    // The product's case: the host owns writes, and its confirm setting says never.
    expect(writeGateActive(setup({ confirmPolicy: 'never', decideWrite: decide }).ctx.session)).toBe(true);
  });
});

describe('assertJudged stays on under a host write policy', () => {
  const input = {
    mode: 'activate' as const,
    frame: frame('main', 'L1'),
    objectId: 'o1',
    name: 'Delete account',
    role: 'button',
    description: 'button "Delete account"',
    action: 'click',
  };
  const unjudged: GateResult = {
    category: undefined,
    confirmedByUser: false,
    prompted: false,
    reason: 'not classified',
  };

  it('catches a button that became a delete between the gate and the release, with confirm set to never', async () => {
    const { ctx } = setup({
      confirmPolicy: 'never',
      decideWrite: () => ({ decision: 'ask', canRemember: true }),
    });
    await expect(assertJudged(ctx, input, unjudged, 'the release')).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  });

  it('is skipped only when nothing gates writes', async () => {
    const { ctx, tab } = setup({ confirmPolicy: 'never' });
    await expect(assertJudged(ctx, input, unjudged, 'the release')).resolves.toBeUndefined();
    expect(tab.probe.call).not.toHaveBeenCalled();
  });
});

describe('approval waits: the page is checked again before dispatch', () => {
  it('approves when the document is unchanged (a fragment change does not count)', async () => {
    const { ctx, requests } = setup({ during: s => (s.url = 'https://shop.test/cart#details') });
    const gate = await upload(ctx);
    expect(gate).toMatchObject({ confirmedByUser: true, prompted: true });
    expect(requests).toHaveLength(1);
  });

  it('refuses with STALE_DOCUMENT when the main frame loaded a new document while the user decided', async () => {
    const { ctx } = setup({ during: s => (s.frames = [frame('main', 'L2')]) });
    const error = await upload(ctx).catch(e => e);
    expect(error).toBeInstanceOf(LayerError);
    expect(error).toMatchObject({ code: 'STALE_DOCUMENT', delivered: false });
    expect(error.message).toMatch(/new document/);
    expect(error.message).toMatch(/Nothing was dispatched/);
  });

  it('refuses when the address changed within the document (a single-page route change)', async () => {
    const { ctx } = setup({ during: s => (s.url = 'https://shop.test/checkout') });
    await expect(upload(ctx)).rejects.toMatchObject({ code: 'STALE_DOCUMENT' });
  });

  it('refuses when the target frame loaded a new document, or went away', async () => {
    const child = frame('child', 'C1', 'main');
    const changed = setup({
      frames: [frame('main', 'L1'), child],
      during: s => (s.frames = [frame('main', 'L1'), frame('child', 'C2', 'main')]),
    });
    await expect(upload(changed.ctx, child)).rejects.toMatchObject({ code: 'STALE_DOCUMENT' });
    const gone = setup({ frames: [frame('main', 'L1'), child], during: s => (s.frames = [frame('main', 'L1')]) });
    await expect(upload(gone.ctx, child)).rejects.toMatchObject({ code: 'FRAME_DETACHED' });
  });

  it('keeps the site check first: leaving the site is TARGET_CHANGED', async () => {
    const { ctx } = setup({ during: s => (s.url = 'https://other.test/') });
    await expect(upload(ctx)).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  });
});

describe('refusals carry who decided and whether to retry', () => {
  it('a declined action: decided by the user, not retryable, ends with the fixed sentence', async () => {
    const { ctx } = setup({ answer: 'decline' });
    const error = (await upload(ctx).catch(e => e)) as LayerError;
    expect(error.code).toBe('USER_DECLINED');
    expect(error.toProtocol()).toMatchObject({ decisionSource: 'user', retryable: false });
    expect(error.hint.endsWith(REFUSAL_NOTICE)).toBe(true);
  });

  it('no answer in time: decided by the user, not retryable', async () => {
    const { ctx } = setup({ answer: 'never', timeoutMs: 30 });
    const error = (await upload(ctx).catch(e => e)) as LayerError;
    expect(error.code).toBe('CONFIRMATION_TIMEOUT');
    expect(error.toProtocol()).toMatchObject({ decisionSource: 'user', retryable: false });
    expect(error.hint.endsWith(REFUSAL_NOTICE)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { LayerError, REFUSAL_NOTICE } from '../../protocol/errors';
import type { ErrorCode } from '../../protocol/errors';
import { errorText } from '../error-text';
import { Controller } from '../controller';
import type { TabHost } from '../ports';

describe('typed refusals', () => {
  it.each([
    ['USER_DECLINED', 'user'],
    ['CONFIRMATION_TIMEOUT', 'user'],
    ['USER_STEP', 'layer-policy'],
    ['NEEDS_USER', 'layer-policy'],
    ['CAPABILITY_DISABLED', 'layer-policy'],
    ['URL_NOT_ALLOWED', 'url-policy'],
  ] as Array<[ErrorCode, string]>)('%s names %s and is not retryable', (code, source) => {
    const error = new LayerError(code, 'No.');
    expect(error.toProtocol()).toMatchObject({ decisionSource: source, retryable: false });
    expect(error.hint.endsWith(REFUSAL_NOTICE)).toBe(true);
    // The fixed sentence is there once, whatever hint the thrower gave.
    expect(new LayerError(code, 'No.', { hint: `${error.hint}` }).hint.split(REFUSAL_NOTICE)).toHaveLength(2);
  });

  it('lets the thrower name another source', () => {
    const error = new LayerError('URL_NOT_ALLOWED', 'Blocked.', { decisionSource: 'site-rule' });
    expect(error.toProtocol()).toMatchObject({ decisionSource: 'site-rule', retryable: false });
  });

  it('leaves other errors without provenance and without the sentence', () => {
    const error = new LayerError('NO_MATCH', 'None.');
    expect(error.toProtocol()).not.toHaveProperty('decisionSource');
    expect(error.toProtocol()).not.toHaveProperty('retryable');
    expect(error.hint).not.toContain(REFUSAL_NOTICE);
  });

  it('prints a refusal as a decision, not as safe to retry, and ends with the sentence', () => {
    const text = errorText(new LayerError('USER_DECLINED', 'The user declined: click Delete.').toProtocol());
    expect(text).toContain('do not retry');
    expect(text).toContain('decided by the user');
    expect(text).not.toContain('safe to retry');
    expect(text.endsWith(REFUSAL_NOTICE)).toBe(true);
    expect(errorText(new LayerError('NO_MATCH', 'None.').toProtocol())).toContain('safe to retry');
  });
});

describe('a refusal from a session call', () => {
  it('names the layer policy for a capability the session lacks, and ends the text with the sentence', async () => {
    const controller = await Controller.create({
      attacher: { attach: async () => Promise.reject(new Error('not used')) },
      tabs: { onRemoved: () => () => undefined, onNavigationTarget: () => () => undefined } as unknown as TabHost,
      epochStore: { read: async () => null, write: async () => undefined },
    });
    const session = controller.createSession({ capabilities: [] });
    const result = await session.call('upload', { attachments: [] });
    expect(result.error).toMatchObject({
      code: 'CAPABILITY_DISABLED',
      decisionSource: 'layer-policy',
      retryable: false,
    });
    expect(result.text.endsWith(REFUSAL_NOTICE)).toBe(true);
  });

  it('names a site rule for a tab on a blocked site', async () => {
    const controller = await Controller.create({
      attacher: { attach: async () => Promise.reject(new Error('not used')) },
      tabs: {
        onRemoved: () => () => undefined,
        onNavigationTarget: () => () => undefined,
        get: async () => ({ tabId: 3, url: 'https://blocked.test/x', title: '' }),
      } as unknown as TabHost,
      epochStore: { read: async () => null, write: async () => undefined },
    });
    const session = controller.createSession({ urlPolicy: { allow: [], deny: [], blocked: ['blocked.test'] } });
    const error = await session.checkTabSite(3).catch(e => e);
    expect(error).toMatchObject({ code: 'URL_NOT_ALLOWED', decisionSource: 'site-rule', retryable: false });
  });
});

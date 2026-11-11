// The text of an error result for a model. A refusal that trying again will not change says so in place of "safe to
// retry" (nothing was dispatched, but the same action is not to be repeated), names who decided, and ends with the
// fixed sentence the error's hint carries.
import type { ProtocolError } from '../protocol/errors';
import { errorLine } from './text';

const SOURCES: Record<NonNullable<ProtocolError['decisionSource']>, string> = {
  user: 'decided by the user',
  'site-rule': "decided by the user's rule for this site",
  'permission-mode': "decided by the conversation's permission mode",
  'url-policy': 'decided by the navigation policy',
  'layer-policy': "decided by the browser layer's fixed policy",
};

export function errorText(error: ProtocolError): string {
  if (error.retryable !== false || !error.decisionSource) return errorLine(error);
  const delivery =
    error.delivered === false
      ? 'refused, nothing dispatched; do not retry'
      : error.delivered === 'unknown'
        ? 'refused, delivery unknown; do not retry'
        : 'refused, input was delivered; do not retry';
  return `error ${error.code} (${delivery}; ${SOURCES[error.decisionSource]})\n${error.message}\n${error.hint}`;
}

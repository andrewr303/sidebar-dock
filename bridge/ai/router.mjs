import { createAiProviderService, PROVIDER_TYPES } from './providers.mjs';
import { createCliService, redactCliOutput } from './cli.mjs';
import { assemblePrompt } from '../../extension/lib/ai-prompts.js';
import { fileURLToPath } from 'node:url';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const ID = /^[\w-]{1,100}$/;
const stringOption = (value, name, maximum = 500) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1f]/.test(value)) throw new Error(`${name} is invalid.`);
  return value;
};
function imageBlocks(context) {
  const images = context.imageAttachments ?? [];
  if (!Array.isArray(images) || images.length > 3) throw new Error('Attach no more than three images to an AI request.');
  return images.map(image => {
    const dataUrl = typeof image === 'string' ? image : object(image) ? image.dataUrl : null;
    const match = typeof dataUrl === 'string' && /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match || match[2].length % 4 || match[2].length > Math.ceil(8 * 1024 * 1024 / 3) * 4) throw new Error('AI images must be base64 PNG, JPEG, GIF or WebP files up to 8 MB each.');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || bytes.toString('base64') !== match[2]) throw new Error('An attached AI image has invalid base64 or exceeds 8 MB.');
    return { type: 'image', dataUrl };
  });
}
function assembleRequest(body) {
  if (!object(body)) throw new Error('The AI request must be a JSON object.');
  if (typeof body.providerId !== 'string' || (!ID.test(body.providerId) && !['cli:codex', 'cli:claude'].includes(body.providerId))) throw new Error('Choose a saved provider or supported CLI agent.');
  const context = body.context ?? {};
  if (!object(context)) throw new Error('AI context must be an object.');
  if (context.sources !== undefined && (!Array.isArray(context.sources) || context.sources.length > 24 || context.sources.some(source => !object(source)))) throw new Error('Choose no more than 24 valid source items.');
  const images = imageBlocks(context);
  const prompt = assemblePrompt({ query: body.query, intent: body.intent, context, history: body.history, targetLanguage: body.targetLanguage, tone: body.tone, depth: body.depth });
  const settings = { model: stringOption(body.model, 'Model'), reasoningEffort: stringOption(body.reasoningEffort, 'Reasoning effort', 40) };
  if (body.temperature !== undefined) {
    if (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2) throw new Error('Temperature must be between 0 and 2.');
    settings.temperature = body.temperature;
  }
  if (body.maxOutputTokens !== undefined) {
    if (!Number.isInteger(body.maxOutputTokens) || body.maxOutputTokens < 1 || body.maxOutputTokens > 1000000) throw new Error('Maximum output tokens is out of range.');
    settings.maxOutputTokens = body.maxOutputTokens;
  }
  if (images.length) {
    if (body.providerId.startsWith('cli:')) throw new Error('CLI chat currently accepts text context. Choose an image-capable API provider for image attachments.');
    const last = prompt.messages.at(-1);
    last.content = [{ type: 'text', text: last.content }, ...images];
  }
  // The application constructs the system instruction; body.system and arbitrary flags are ignored.
  return { prompt, settings };
}

export function createAiRouter({ providers = createAiProviderService(), cli = createCliService(), timeoutMs = 300000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60 * 1000) throw new Error('AI route timeout must be between one millisecond and fifteen minutes.');
  async function chat(request, response, { readJson, reply }) {
    const controller = new AbortController();
    let partialText = '', started = false;
    const abortUpload = () => controller.abort(new Error('The AI request was disconnected.'));
    const abortResponse = () => { if (!response.writableEnded) controller.abort(new Error('The AI response was disconnected.')); };
    request.once('aborted', abortUpload); response.once('close', abortResponse);
    const timer = setTimeout(() => controller.abort(new Error('The AI request timed out.')), timeoutMs); timer.unref?.();
    const send = event => {
      if (response.destroyed || controller.signal.aborted) return;
      response.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const body = await readJson(request);
      const { prompt, settings } = assembleRequest(body);
      if (body.context?.imageAttachments?.length) {
        const provider = (await providers.listProviders()).find(provider => provider.id === body.providerId);
        if (!provider?.capabilities?.images) throw new Error('Enable image input only after confirming this model supports it.');
      }
      controller.signal.throwIfAborted();
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
      response.flushHeaders?.(); started = true;
      send({ type: 'start', promptVersion: prompt.version, sources: prompt.sources });
      const onDelta = value => {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (typeof value !== 'string') throw new Error('The AI generator returned a non-text delta.');
        partialText += value;
        if (partialText.length > 4 * 1024 * 1024) { controller.abort(new Error('The AI output exceeded the local limit.')); throw controller.signal.reason; }
        if (value) send({ type: 'delta', text: value });
      };
      const input = { system: prompt.system, messages: prompt.messages, ...settings, signal: controller.signal, onDelta };
      let rejectAborted;
      const aborted = new Promise((_, reject) => { rejectAborted = () => reject(controller.signal.reason); });
      controller.signal.addEventListener('abort', rejectAborted, { once: true });
      let result;
      try {
        const generation = body.providerId.startsWith('cli:')
          ? cli.generate({ ...input, agentId: body.providerId.slice(4) })
          : providers.generate({ ...input, providerId: body.providerId });
        result = await Promise.race([generation, aborted]);
      } finally { controller.signal.removeEventListener('abort', rejectAborted); }
      controller.signal.throwIfAborted();
      if (!result || typeof result.text !== 'string' || !result.text.trim()) throw new Error('The AI generator completed without a text answer.');
      send({ type: 'done', text: result.text, model: result.model || settings.model || null, usage: result.usage || null, stopReason: result.stopReason || result.finishReason || null,
        providerId: body.providerId, promptVersion: prompt.version, sources: prompt.sources });
    } catch (error) {
      const message = redactCliOutput(error.message || 'AI request failed.');
      if (!started && !response.headersSent && !response.destroyed) reply(error.status || 400, { error: message });
      else if (!response.destroyed) {
        // Write a terminal error even for a server timeout; a client disconnect has no receiver.
        response.write(`${JSON.stringify({ type: 'error', message, partialText: (typeof error.partialText === 'string' ? error.partialText : partialText).slice(0, 4 * 1024 * 1024), aborted: controller.signal.aborted || error.aborted === true || error.name === 'AbortError' })}\n`);
      }
    } finally {
      clearTimeout(timer); request.removeListener('aborted', abortUpload); response.removeListener('close', abortResponse);
      if (started && !response.writableEnded && !response.destroyed) response.end();
    }
  }
  async function handle(request, response, context) {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (!path.startsWith('/ai/')) return false;
    const { reply, readJson } = context;
    if (path === '/ai/chat' && request.method === 'POST') { await chat(request, response, context); return true; }
    try {
      if (path === '/ai/providers') {
        if (request.method === 'GET') { const [saved, agents] = await Promise.all([providers.listProviders(), cli.listAgents()]); reply(200, { providers: saved, catalog: PROVIDER_TYPES, agents, runtime: { projectRoot: fileURLToPath(new URL('../../', import.meta.url)) } }); }
        else if (request.method === 'POST') reply(201, { provider: await providers.saveProvider(await readJson(request)) });
        else reply(405, { error: 'Use GET or POST for provider settings.' });
        return true;
      }
      const provider = /^\/ai\/providers\/([\w-]{1,100})(?:\/(test|models))?$/.exec(path);
      if (provider) {
        const [, id, action] = provider;
        if (!action && request.method === 'DELETE') reply(200, await providers.deleteProvider(id));
        else if (action === 'test' && request.method === 'POST') reply(200, await providers.testProvider(id));
        else if (action === 'models' && request.method === 'GET') reply(200, { models: await providers.listModels(id) });
        else reply(405, { error: 'Unsupported provider route method.' });
        return true;
      }
      if (path === '/ai/cli/auth') {
        if (request.method === 'GET') reply(200, { agents: await cli.authStatus() }); else reply(405, { error: 'Use GET to read CLI sign-in status.' });
        return true;
      }
      if (path === '/ai/cli/login') {
        if (request.method === 'POST') reply(200, { login: await cli.startCodexLogin() }); else reply(405, { error: 'Use POST to start Codex sign-in.' });
        return true;
      }
      const login = /^\/ai\/cli\/login\/([\w-]{1,100})(?:\/(cancel))?$/.exec(path);
      if (login) {
        if (!login[2] && request.method === 'GET') reply(200, { login: await cli.getLoginStatus(login[1]) });
        else if (login[2] === 'cancel' && request.method === 'POST') reply(200, { login: await cli.cancelLogin(login[1]) });
        else reply(405, { error: 'Unsupported Codex sign-in route method.' });
        return true;
      }
      if (path === '/ai/chat') { reply(405, { error: 'Use POST to send an AI chat request.' }); return true; }
      return false;
    } catch (error) { if (!response.headersSent && !response.destroyed) reply(error.status || 400, { error: redactCliOutput(error.message) }); return true; }
  }
  return { handle };
}

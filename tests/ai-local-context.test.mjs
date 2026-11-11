import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLocalWindow, resetLocalWindows } from '../extension/lib/ai/local-context.js';

const ollama = { id: 'ollama', name: 'Ollama', local: true };
const lmstudio = { id: 'lmstudio', name: 'LM Studio', local: true };
/** A stand-in for the server: answers by URL, records what was asked. */
function server(answers) {
  const asked = [];
  const request = async (url, options = {}) => { asked.push([options.method || 'GET', url, options.body]); const answer = answers[url]; return typeof answer === 'function' ? answer(options) : answer ?? null; };
  return { asked, request };
}

test('Ollama: the window of the running model, as the server loaded it', async () => {
  resetLocalWindows();
  const { asked, request } = server({ 'http://localhost:11434/api/ps': { models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest', context_length: 8192 }, { name: 'other', context_length: 4096 }] } });
  assert.equal(await detectLocalWindow({ provider: ollama, baseUrl: 'http://localhost:11434/', model: 'llama3.2', request }), 8192, 'llama3.2 and llama3.2:latest are the same model');
  assert.deepEqual(asked, [['GET', 'http://localhost:11434/api/ps', undefined]], 'a loaded model needs one request');
});

test('Ollama: a model that is not loaded yet uses the num_ctx it is set to load with, and never the model\'s own maximum', async () => {
  resetLocalWindows();
  const configured = server({ 'http://localhost:11434/api/ps': { models: [] },
    'http://localhost:11434/api/show': { parameters: 'temperature 0.7\nnum_ctx                        16384\nstop "<|eot|>"', model_info: { 'llama.context_length': 131072 } } });
  assert.equal(await detectLocalWindow({ provider: ollama, baseUrl: 'http://localhost:11434', model: 'qwen3', request: configured.request }), 16384);
  assert.deepEqual(configured.asked[1], ['POST', 'http://localhost:11434/api/show', { model: 'qwen3' }]);

  resetLocalWindows();
  const unset = server({ 'http://localhost:11434/api/ps': { models: [] }, 'http://localhost:11434/api/show': { parameters: 'temperature 0.7', model_info: { 'llama.context_length': 131072 } } });
  assert.equal(await detectLocalWindow({ provider: ollama, baseUrl: 'http://localhost:11434', model: 'qwen3', request: unset.request }), 0,
    'what the model could hold says nothing about what the server will load');
});

test('LM Studio: the loaded context of the model, from the address without /v1', async () => {
  resetLocalWindows();
  const { asked, request } = server({ 'http://localhost:1234/api/v0/models': { data: [{ id: 'qwen/qwen3-8b', loaded_context_length: 12000, max_context_length: 131072 }, { id: 'unloaded', max_context_length: 8192 }] } });
  assert.equal(await detectLocalWindow({ provider: lmstudio, baseUrl: 'http://localhost:1234/v1', model: 'qwen/qwen3-8b', request }), 12000);
  assert.equal(asked[0][1], 'http://localhost:1234/api/v0/models');
  assert.equal(await detectLocalWindow({ provider: lmstudio, baseUrl: 'http://localhost:1234/v1', model: 'unloaded', request }), 0);
});

test('an answer is kept for a short while; "not loaded" is not kept; fresh asks again', async () => {
  resetLocalWindows();
  let context = 0;
  let clock = 1000;
  const { asked, request } = server({ 'http://localhost:11434/api/ps': () => ({ models: context ? [{ name: 'm', context_length: context }] : [] }), 'http://localhost:11434/api/show': { parameters: '' } });
  const detect = (extra = {}) => detectLocalWindow({ provider: ollama, baseUrl: 'http://localhost:11434', model: 'm', request, now: () => clock, ...extra });
  assert.equal(await detect(), 0);
  context = 4096;
  assert.equal(await detect(), 4096, 'an unknown answer was not kept, so the server is asked again');
  const requests = asked.length;
  context = 32768;
  assert.equal(await detect(), 4096, 'a recent answer is reused');
  assert.equal(asked.length, requests);
  assert.equal(await detect({ fresh: true }), 32768);
  clock += 31_000;
  context = 2048;
  assert.equal(await detect(), 2048, 'after half a minute the server is asked again');
});

test('anything that is not a local server Still knows, or does not answer, gives 0 without throwing', async () => {
  resetLocalWindows();
  const { asked, request } = server({});
  assert.equal(await detectLocalWindow({ provider: { id: 'anthropic' }, baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5', request }), 0);
  assert.equal(await detectLocalWindow({ provider: ollama, baseUrl: '', model: 'm', request }), 0);
  assert.equal(await detectLocalWindow({ provider: ollama, baseUrl: 'http://localhost:11434', model: '', request }), 0);
  assert.equal(asked.length, 0, 'no request is made for them');
  assert.equal(await detectLocalWindow({ provider: ollama, baseUrl: 'http://localhost:11434', model: 'm', request }), 0, 'a server that answers nothing');
  for (const junk of [{ models: 'no' }, { models: [{ name: 'm', context_length: '8192' }] }, { models: [{ name: 'm', context_length: -5 }] }, 'text', 42]) {
    resetLocalWindows();
    const odd = server({ 'http://localhost:11434/api/ps': junk, 'http://localhost:11434/api/show': { parameters: 12 } });
    assert.equal(await detectLocalWindow({ provider: ollama, baseUrl: 'http://localhost:11434', model: 'm', request: odd.request }), 0, JSON.stringify(junk));
  }
});

test('without an injected request it uses fetch, and a server that is down is not an error', async () => {
  resetLocalWindows();
  const previous = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async url => { urls.push(String(url)); throw new TypeError('fetch failed'); };
  try { assert.equal(await detectLocalWindow({ provider: ollama, baseUrl: 'http://localhost:11434', model: 'm' }), 0); }
  finally { globalThis.fetch = previous; }
  assert.deepEqual(urls, ['http://localhost:11434/api/ps', 'http://localhost:11434/api/show']);
});

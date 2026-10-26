import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createCliService, resolveAgentExecutable, resolveCliLauncher, findCliOnPath, redactCliOutput } from '../bridge/ai/cli.mjs';

const codexHelp = 'Codex CLI exec login app-server --no-daemon';
const codexExecHelp = '--ephemeral --ignore-user-config --ignore-rules --json --sandbox --skip-git-repo-check --color';
const claudeHelp = '--tools --safe-mode --strict-mcp-config --no-session-persistence --output-format --include-partial-messages --restricted --permission-prompts';
let nextPid = 20000;
class FakeChild extends EventEmitter {
  constructor() {
    super(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.stdin = new PassThrough();
    this.pid = nextPid++; this.exitCode = null; this.signals = []; this.input = '';
    this.stdin.on('data', bytes => { this.input += bytes.toString(); });
  }
  line(value) { this.stdout.write(JSON.stringify(value) + '\n'); }
  finish(code = 0, signal = null) { if (this.closed) return; this.closed = true; this.exitCode = code; this.emit('close', code, signal); }
  kill(signal = 'SIGTERM') { this.signals.push(signal); this.finish(null, signal); return true; }
}

async function fixture(t, handler = () => {}, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'still-cli-test-'));
  assert.ok(directory.startsWith(resolve(tmpdir()) + sep) && basename(directory).startsWith('still-cli-test-'));
  const paths = { codex: join(directory, 'codex.exe'), claude: join(directory, 'claude.exe') };
  await Promise.all(Object.values(paths).map(path => writeFile(path, 'test-only mock executable; never executed')));
  const calls = [];
  const children = [];
  const spawn = (command, args, spawnOptions) => {
    const child = new FakeChild();
    calls.push({ command, args, options: spawnOptions, child }); children.push(child);
    process.nextTick(() => {
      if (basename(command).toLowerCase() === 'taskkill.exe') {
        const target = children.find(value => String(value.pid) === args[1]); target?.finish(null, 'SIGTERM'); child.finish(); return;
      }
      if (args.length === 1 && args[0] === '--help') { child.stdout.write(command === paths.codex ? codexHelp : claudeHelp); child.finish(); return; }
      if (args[0] === 'exec' && args[1] === '--help') { child.stdout.write(codexExecHelp); child.finish(); return; }
      handler({ child, command, args, options: spawnOptions });
    });
    return child;
  };
  const service = createCliService({ spawn, which: async name => paths[name] ? [paths[name]] : [], cwdRoot: join(directory, 'runs'), platform: 'linux', ...options });
  t.after(async () => { service.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { service, directory, paths, calls, children };
}

test('discovers CLI paths and safety flags without auth or inference', async t => {
  const { service, calls } = await fixture(t);
  const agents = await service.listAgents();
  assert.deepEqual(agents.map(agent => [agent.id, agent.status]), [['codex', 'ready'], ['claude', 'ready']]);
  assert.equal(agents[0].capabilities.toolsDisabled, false);
  assert.match(agents[0].capabilities.restrictions, /no verified universal no-tools/);
  assert.equal(agents[1].capabilities.toolsDisabled, true);
  assert.ok(calls.every(call => call.args.includes('--help')));
  assert.ok(calls.every(call => call.options.windowsHide === true && call.options.shell === false));
  assert.equal(JSON.stringify(agents).includes('_launcher'), false);
});

test('PATH lookup accepts executable names only and never executes a shell', async t => {
  const { directory, paths } = await fixture(t);
  const found = await findCliOnPath('codex', { env: { PATH: directory }, platform: 'win32' });
  assert.deepEqual(found, [paths.codex]);
  assert.deepEqual(await findCliOnPath('codex & whoami', { env: { PATH: directory }, platform: 'win32' }), []);
  const launcher = await resolveAgentExecutable('codex', { which: async () => found });
  assert.equal(launcher.path, paths.codex);
  assert.deepEqual(launcher.prefix, []);
});

test('resolves standard npm cmd shims to a known package Node entry without running cmd', async t => {
  const { directory } = await fixture(t);
  const shim = join(directory, 'codex.cmd');
  const entry = join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, '// mock launcher');
  await writeFile(shim, '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  const launcher = await resolveCliLauncher('codex', shim);
  assert.equal(launcher.command, process.execPath);
  assert.deepEqual(launcher.prefix, [entry]);
  assert.equal(launcher.launchMode, 'validated-node-entry');
  await writeFile(shim, '@echo off\r\npowershell -Command do-anything\r\n');
  await assert.rejects(resolveCliLauncher('codex', shim), /Unsupported CLI shim/);
});

test('Codex request is ephemeral/read-only with exact model and effort, prompt only on stdin', async t => {
  const { service, calls, directory } = await fixture(t, ({ child }) => {
    child.line({ type: 'thread.started', thread_id: 'new-thread' });
    child.line({ type: 'item.completed', item: { type: 'agent_message', text: 'A sourced answer.' } });
    child.line({ type: 'turn.completed', usage: { input_tokens: 30, output_tokens: 4 } }); child.finish();
  });
  const deltas = [];
  const result = await service.generate({ agentId: 'codex', system: 'Application instructions', messages: [{ role: 'user', content: 'private source excerpt' }], model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', onDelta: text => deltas.push(text) });
  const call = calls.find(value => value.args.includes('--json'));
  assert.ok(call.args.includes('--ephemeral') && call.args.includes('--ignore-user-config') && call.args.includes('--ignore-rules'));
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(call.args.includes('--no-daemon') && call.args.includes('shell_tool') && call.args.includes('web_search="disabled"'));
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'gpt-6.1-sol');
  assert.ok(call.args.includes('model_reasoning_effort="xhigh"'));
  assert.equal(call.args.join(' ').includes('private source excerpt'), false);
  assert.match(call.child.input, /private source excerpt/);
  assert.notEqual(call.options.cwd, process.cwd());
  assert.deepEqual(await readdir(join(directory, 'runs')), []);
  assert.equal(result.text, 'A sourced answer.');
  assert.deepEqual(deltas, ['A sourced answer.']);
});

test('Claude uses its existing session while built-ins/MCP/customizations are disabled', async t => {
  const { service, calls } = await fixture(t, ({ child }) => {
    child.line({ type: 'system', subtype: 'init', tools: [] });
    child.line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } });
    child.line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } } });
    child.line({ type: 'result', subtype: 'success', result: 'Hello world', is_error: false, usage: { input_tokens: 10 } }); child.finish();
  });
  const deltas = [];
  const result = await service.generate({ agentId: 'claude', messages: [{ role: 'user', content: 'Hi' }], onDelta: value => deltas.push(value) });
  const flags = calls.find(value => value.args.includes('-p')).args;
  assert.equal(flags[flags.indexOf('--tools') + 1], '');
  assert.ok(flags.includes('--strict-mcp-config') && flags.includes('mcp__*') && flags.includes('--safe-mode') && flags.includes('--no-session-persistence'));
  assert.equal(flags.includes('--bare'), false);
  assert.equal(flags.includes('--resume'), false);
  assert.deepEqual(deltas, ['Hello ', 'world']);
  assert.equal(result.text, 'Hello world');
});

test('configured paths and arguments cannot become arbitrary commands', async t => {
  const { service } = await fixture(t);
  await assert.rejects(service.generate({ agentId: 'codex', executable: 'C:\\attacker.exe', messages: [{ role: 'user', content: 'Hi' }] }), /detected PATH executable/);
  await assert.rejects(service.generate({ agentId: 'codex', model: 'model; del C:', messages: [{ role: 'user', content: 'Hi' }] }), /Invalid model/);
  await assert.rejects(service.generate({ agentId: 'shell', messages: [{ role: 'user', content: 'Hi' }] }), /Select Codex CLI or Claude Code/);
});

test('observed Codex tool calls stop only the owned request and report incomplete output', async t => {
  const { service, calls } = await fixture(t, ({ child }) => {
    child.line({ type: 'item.completed', item: { type: 'agent_message', text: 'Partial answer' } });
    child.line({ type: 'item.started', item: { type: 'command_execution', command: 'must not run' } });
  });
  await assert.rejects(service.generate({ agentId: 'codex', messages: [{ role: 'user', content: 'Hi' }] }), error => {
    assert.match(error.message, /unsupported tool/); assert.equal(error.partialText, 'Partial answer'); return true;
  });
  const child = calls.find(value => value.args.includes('--json')).child;
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('zero exit with missing/failed completion never counts partial text as success', async t => {
  const { service } = await fixture(t, ({ child }) => {
    child.line({ type: 'item.completed', item: { type: 'agent_message', text: 'Partial' } }); child.finish();
  });
  await assert.rejects(service.generate({ agentId: 'codex', messages: [{ role: 'user', content: 'Hi' }] }), /successful completion event/);
});

test('CLI error output redacts credentials and nonzero exit rejects even after a completion event', async t => {
  const { service } = await fixture(t, ({ child }) => {
    child.line({ type: 'turn.completed' }); child.stderr.write('Authorization: Bearer secret-token-123 and api_key=sk-secretsecretsecret123'); child.finish(1);
  });
  await assert.rejects(service.generate({ agentId: 'codex', messages: [{ role: 'user', content: 'Hi' }] }), error => {
    assert.match(error.message, /exited with code 1/); assert.equal(error.message.includes('secret-token'), false); assert.equal(error.message.includes('sk-secret'), false); return true;
  });
  assert.equal(redactCliOutput('{"refresh_token":"private-refresh-value"}').includes('private-refresh'), false);
});

test('Claude result-level failures and unexpected enabled tools reject safely', async t => {
  let variant = 'failed';
  const { service } = await fixture(t, ({ child }) => {
    if (variant === 'failed') { child.line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Authentication required' }); child.finish(); }
    else child.line({ type: 'system', subtype: 'init', tools: ['Read'] });
  });
  await assert.rejects(service.generate({ agentId: 'claude', messages: [{ role: 'user', content: 'Hi' }] }), /Authentication required/);
  variant = 'tools';
  await assert.rejects(service.generate({ agentId: 'claude', messages: [{ role: 'user', content: 'Hi' }] }), /enabled tools/);
});

test('abort terminates only the tracked child and cleans its temporary directory', async t => {
  const controller = new AbortController();
  const { service, directory, calls } = await fixture(t, () => { controller.abort(); });
  await assert.rejects(service.generate({ agentId: 'codex', signal: controller.signal, messages: [{ role: 'user', content: 'Hi' }] }), { name: 'AbortError' });
  assert.deepEqual(calls.find(call => call.args.includes('--json')).child.signals, ['SIGTERM']);
  assert.deepEqual(await readdir(join(directory, 'runs')), []);
});

test('Windows cancellation targets the owned PID tree with no shell or process-name kill', async t => {
  const controller = new AbortController();
  const { service, calls } = await fixture(t, () => controller.abort(), { platform: 'win32' });
  await assert.rejects(service.generate({ agentId: 'codex', signal: controller.signal, messages: [{ role: 'user', content: 'Hi' }] }), { name: 'AbortError' });
  const invocation = calls.find(call => basename(call.command).toLowerCase() === 'taskkill.exe');
  const target = calls.find(call => call.args.includes('--json')).child.pid;
  assert.deepEqual(invocation.args, ['/PID', String(target), '/T', '/F']);
  assert.equal(invocation.options.windowsHide, true); assert.equal(invocation.options.shell, false);
});

test('auth status exposes only sanitized authentication state, never tokens or account identity', async t => {
  const { service } = await fixture(t, ({ child, args }) => {
    if (args[0] === 'login') child.stdout.write('Logged in using an API key - sk-privateprivateprivate');
    else child.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'private@example.com', accessToken: 'private-token' }));
    child.finish();
  });
  const result = await service.authStatus();
  assert.deepEqual(result, { codex: { status: 'authenticated', method: 'api_key' }, claude: { status: 'authenticated', method: 'claude.ai' } });
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('Codex OAuth is explicit structured device login and reports actual completion', async t => {
  let loginChild;
  const { service, calls } = await fixture(t, ({ child, args }) => {
    assert.deepEqual(args.slice(0, 2), ['app-server', '--stdio']); loginChild = child;
    let input = '';
    const handle = bytes => {
      input += bytes.toString(); const lines = input.split('\n'); input = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line);
        if (message.method === 'initialize') process.nextTick(() => child.line({ id: 1, result: { userAgent: 'codex' } }));
        if (message.method === 'account/login/start') {
          assert.deepEqual(message.params, { type: 'chatgptDeviceCode' });
          process.nextTick(() => child.line({ id: 2, result: { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' } }));
        }
      }
    };
    child.stdin.on('data', handle); handle(child.input);
  });
  assert.ok((await service.listAgents()).every(agent => agent.available));
  assert.equal(calls.some(call => call.args.includes('app-server')), false);
  const login = await service.startCodexLogin();
  assert.equal(login.status, 'user_action_needed');
  assert.equal(login.verificationUri, 'https://auth.openai.com/codex/device');
  assert.equal(login.userCode, 'ABCD-1234');
  loginChild.line({ method: 'account/login/completed', params: { loginId: 'login-1', success: true } });
  assert.equal(service.getLoginStatus(login.id).status, 'authenticated');
  assert.equal(service.getLoginStatus(login.id).userCode, undefined);
});

test('Codex OAuth failure/cancel never becomes authenticated or exposes auth output', async t => {
  let loginChild;
  const { service } = await fixture(t, ({ child }) => {
    loginChild = child; let input = '';
    const handle = bytes => {
      input += bytes.toString(); const lines = input.split('\n'); input = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line);
        if (message.method === 'initialize') process.nextTick(() => child.line({ id: 1, result: {} }));
        if (message.method === 'account/login/start') process.nextTick(() => child.line({ id: 2, result: { type: 'chatgptDeviceCode', loginId: 'login-2', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ZZZZ-1111' } }));
      }
    };
    child.stdin.on('data', handle); handle(child.input);
  });
  const login = await service.startCodexLogin();
  const cancelled = service.cancelLogin(login.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.match(loginChild.input, /account\/login\/cancel/);
  assert.deepEqual(loginChild.signals, ['SIGTERM']);
  assert.equal(service.getLoginStatus(login.id).status, 'cancelled');
});

test('OAuth protocol failures remain failed and redact token-bearing diagnostic messages', async t => {
  const { service } = await fixture(t, ({ child }) => {
    let input = '';
    const handle = bytes => {
      input += bytes.toString(); const lines = input.split('\n'); input = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line);
        if (message.method === 'initialize') process.nextTick(() => child.line({ id: 1, result: {} }));
        if (message.method === 'account/login/start') process.nextTick(() => child.line({ id: 2, error: { message: 'Unavailable access_token=private-auth-token' } }));
      }
    };
    child.stdin.on('data', handle); handle(child.input);
  });
  const login = await service.startCodexLogin();
  assert.equal(login.status, 'failed');
  assert.equal(JSON.stringify(login).includes('private-auth-token'), false);
  assert.equal(login.userCode, undefined);
});

test('invalid JSON in a generation stream is a failure rather than plain-text success', async t => {
  const { service } = await fixture(t, ({ child }) => { child.stdout.write('not JSON\n'); child.finish(); });
  await assert.rejects(service.generate({ agentId: 'codex', messages: [{ role: 'user', content: 'Hi' }] }), /invalid JSON/);
});

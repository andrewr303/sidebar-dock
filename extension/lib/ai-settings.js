import { icon as libraryIcon } from './icons.js';
import { configureBridge, syncBridgeOnce, getIntegrationSettings, getMcpSetup } from './integrations.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = name => name === 'lock' ? '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></svg>' : libraryIcon(name);
const PROVIDERS = [
  { type: 'openai', name: 'OpenAI', mark: '◎', color: '#5d8b79', category: 'Cloud APIs', description: 'Responses API · your account, your model', baseUrl: 'https://api.openai.com/v1' },
  { type: 'anthropic', name: 'Anthropic', mark: 'A', color: '#b57b60', category: 'Cloud APIs', description: 'Claude models through the Messages API', baseUrl: 'https://api.anthropic.com/v1' },
  { type: 'cloudflare', name: 'Cloudflare', mark: '☁', color: '#ce8a48', category: 'Cloud APIs', description: 'Workers AI · account ID and API token', baseUrl: 'https://api.cloudflare.com/client/v4' },
  { type: 'openrouter', name: 'OpenRouter', mark: '↗', color: '#8b86ae', category: 'Cloud APIs', description: 'One endpoint for the models you choose', baseUrl: 'https://openrouter.ai/api/v1' },
  { type: 'bedrock', name: 'AWS Bedrock', mark: '▱', color: '#a188bb', category: 'Cloud APIs', description: 'ConverseStream · AWS credentials or profile', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com' },
  { type: 'gemini', name: 'Google Gemini', mark: '✦', color: '#7799bd', category: 'Cloud APIs', description: 'Gemini API · streaming text and images', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { type: 'openai-compatible', name: 'OpenAI compatible', mark: '↔', color: '#8e8e9d', category: 'Compatible endpoints', description: 'Your own Chat Completions endpoint', baseUrl: '' },
  { type: 'anthropic-compatible', name: 'Anthropic compatible', mark: '↔', color: '#a79789', category: 'Compatible endpoints', description: 'Your own Messages API endpoint', baseUrl: '' },
  { type: 'ollama', name: 'Ollama', mark: '◉', color: '#828e89', category: 'On your device', description: 'Native local models · no cloud account needed', baseUrl: 'http://127.0.0.1:11434' },
  { type: 'lmstudio', name: 'LM Studio', mark: 'LM', color: '#9887b0', category: 'On your device', description: 'Use the model running on your local server', baseUrl: 'http://127.0.0.1:1234/v1' },
];
const action = (name, label, attrs = '', className = 'as-button') => `<button type="button" class="${className}" data-ai-settings-action="${name}" ${attrs}>${label}</button>`;
const logo = (mark, color) => `<span class="as-logo" style="--as-logo-color:${color}">${esc(mark)}</span>`;
const badge = (text, tone = '') => `<span class="as-badge ${tone}">${esc(text)}</span>`;
const input = (name, label, value = '', options = '') => `<label class="as-field">${label}<input name="${name}" value="${esc(value)}" ${options}></label>`;
const check = (name, label, checked, description = '') => `<label class="as-checkbox"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}><span><strong>${label}</strong>${description ? `<small>${description}</small>` : ''}</span></label>`;
const listResult = (value, key) => Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : [];

export function createAiSettings({ client, getPreferences = () => ({}), savePreferences = async () => {}, onProviderSelected = () => {}, onPair = () => {}, toast = () => {} }) {
  let dialog, tab = 'providers', config = { providers: [], catalog: [], agents: [] }, clients = [], integration = {}, connected = false;
  let editing = null, loginJob = null, loginTimer, renderVersion = 0;
  const previews = new Map();
  const receipts = new Map();
  const cliDrafts = new Map();
  const auth = {};
  const setup = getMcpSetup();
  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement('dialog'); dialog.className = 'ai-settings'; dialog.setAttribute('aria-labelledby', 'as-title');
    dialog.innerHTML = `<div class="as-shell"><header class="as-header"><div class="as-header-icon">${icon('bolt')}</div><div><span class="as-eyebrow">YOUR WORKSPACE, CONNECTED</span><h2 id="as-title">A little more possibility.</h2><p>Your models. Your library. One thoughtful workspace.</p></div>${action('close', icon('close'), 'aria-label="Close AI settings"', 'as-icon-button as-close')}</header><nav class="as-tabs" aria-label="AI settings categories">${[['providers','bolt','AI providers'],['mcp','plug','MCP & agents'],['preferences','edit','Writing defaults']].map(([id, symbol, label]) => action('tab', `${icon(symbol)} ${label}`, `data-tab="${id}" role="tab" aria-selected="false"`)).join('')}</nav><div class="as-message" role="status" aria-live="polite" hidden></div><div class="as-content"></div><footer class="as-footer"><span>${icon('lock')} Credentials stay in the local bridge</span><span>Made for the way you think.</span></footer></div>`;
    document.body.append(dialog);
    dialog.addEventListener('click', event => {
      event.stopPropagation();
      if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close(); return; }
      const button = event.target.closest('[data-ai-settings-action]'); if (button) handleAction(button).catch(error => message(error.message, 'error'));
    });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); handleSubmit(event.target).catch(error => message(error.message, 'error')); });
    dialog.addEventListener('change', event => {
      event.stopPropagation(); const element = event.target;
      if (element.name === 'providerType') { editing = { type: element.value }; render(); }
      else if (element.name === 'temperatureSupported') { const temperature = dialog.querySelector('[name="temperature"]'); if (temperature) temperature.disabled = !element.checked; }
      else if (element.name === 'useDefaultCredentials') { const group = dialog.querySelector('.as-aws-explicit'); if (group) { group.hidden = element.checked; group.querySelectorAll('input').forEach(field => { field.disabled = element.checked; }); } }
      else if (element.name === 'supportedEfforts') updateEfforts(element.value);
      else if (element.name === 'region') { const base = dialog.querySelector('[name="baseUrl"]'); if (base && /^https:\/\/bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/.test(base.value) && /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(element.value)) base.value = `https://bedrock-runtime.${element.value}.amazonaws.com`; }
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); close(); });
    dialog.addEventListener('close', () => { clearTimeout(loginTimer); renderVersion++; });
  }
  function message(text = '', tone = '') {
    const element = dialog?.querySelector('.as-message'); if (!element) return;
    element.textContent = text; element.className = `as-message ${tone}`; element.hidden = !text;
  }
  async function busy(button, work) {
    const wasDisabled = button?.disabled;
    if (button) { button.disabled = true; button.dataset.busy = 'true'; }
    try { return await work(); }
    finally { if (button?.isConnected) { button.disabled = wasDisabled; delete button.dataset.busy; } }
  }
  function pairCard() {
    return `<section class="as-pair-card"><div class="as-pair-heading"><span class="as-pair-symbol">${icon('plug')}</span><div><h3>Your local bridge</h3><p>${connected ? 'Paired and reachable on this device.' : integration.bridgeConfigured ? 'A pairing is saved. Start the bridge to reach it.' : 'A small local companion connects your models and agents.'}</p></div>${badge(connected ? 'Reachable' : 'Setup needed', connected ? 'positive' : '')}</div><details ${connected ? '' : 'open'}><summary>${connected ? 'Pairing details' : 'Start & pair the bridge'} ${icon('down')}</summary><ol class="as-steps"><li>Run this command once in a terminal.<div class="as-copy-row"><code>${esc(setup.start)}</code>${action('copy-start', icon('copy'), 'aria-label="Copy bridge start command"', 'as-icon-button')}</div></li><li>Copy the private token from <code>${esc(setup.configPath)}</code>.</li><li>Paste it below. The token stays in this browser’s local integration settings.</li></ol><form class="as-pair-form" data-as-form="pair">${input('bridgeUrl','Bridge address',integration.bridgeUrl || 'http://127.0.0.1:43123','type="url" required')}${input('bridgeToken','Private bridge token','','type="password" autocomplete="off" required placeholder="Paste the token from the local config file"')}<button class="as-button primary" type="submit">${icon('plug')} Pair this workspace</button></form><p class="as-footnote">The bridge keeps running in your terminal. Open a Still view to share the library with MCP clients.</p></details></section>`;
  }
  function cliCard(id, name, mark, color) {
    const agent = config.agents.find(agent => agent.id === id);
    const preferences = getPreferences(); const selected = preferences.providerId === `cli:${id}`;
    const status = auth[id]; const available = agent?.capabilities?.generate === true;
    const label = !agent ? 'Not checked' : !agent.available ? 'Not found' : available ? 'CLI ready' : 'Unsupported version';
    return `<article class="as-cli-card ${selected ? 'selected' : ''}"><div class="as-card-heading">${logo(mark,color)}<div><h4>${name}</h4><p>${id === 'codex' ? 'Use Codex with your existing ChatGPT sign-in.' : 'Use the Claude Code session on this device.'}</p></div>${badge(label, available ? 'positive' : '')}</div><div class="as-cli-meta">${status ? `<span>Sign-in: <strong>${esc(status.status)}</strong>${status.method ? ` · ${esc(status.method)}` : ''}</span>` : '<span>Sign-in has not been checked.</span>'}${agent?.executable ? `<code title="${esc(agent.executable)}">${esc(agent.executable)}</code>` : ''}</div>${agent?.reason ? `<p class="as-card-note">${esc(agent.reason)}</p>` : ''}<details class="as-restrictions"><summary>How this agent runs ${icon('down')}</summary><p>${esc(agent?.capabilities?.restrictions || 'Still checks the installed agent and required isolation flags before using it. Installation and authentication are managed on your device.')}</p></details><div class="as-cli-options"><label>Model ID <input data-as-agent-model="${id}" value="${esc(selected ? preferences.model || '' : '')}" placeholder="Use CLI default"></label><label>Reasoning effort <select data-as-agent-effort="${id}">${['','none','minimal','low','medium','high','xhigh','max'].map(value => `<option value="${value}" ${selected && (preferences.reasoningEffort || '') === value ? 'selected' : ''}>${value || 'CLI default'}</option>`).join('')}</select></label></div><div class="as-card-actions">${action('use-cli', selected ? `${icon('check')} Selected` : 'Use this agent', `data-id="${id}" ${!available ? 'disabled' : ''}`, `as-button ${selected ? 'selected' : 'primary'}`)}${action('check-auth','Check sign-in',`data-id="${id}" ${!agent?.available ? 'disabled' : ''}`)}${id === 'codex' ? action('login',`${icon('external')} Sign in with ChatGPT`,`${!agent?.capabilities?.oauthLogin ? 'disabled' : ''}`) : '<a href="https://code.claude.com/docs/en/quickstart" target="_blank" rel="noopener noreferrer" class="as-link">Claude setup ↗</a>'}</div>${id === 'codex' ? renderLogin() : ''}</article>`;
  }
  function renderLogin() {
    if (!loginJob) return '';
    const pending = ['pending','user_action_needed'].includes(loginJob.status);
    let verification = '';
    if (loginJob.verificationUri) { try { const url = new URL(loginJob.verificationUri); if (url.protocol === 'https:' && url.hostname === 'auth.openai.com' && !url.username && !url.password) verification = url.href; } catch {} }
    return `<div class="as-login-state ${loginJob.status === 'authenticated' ? 'positive' : ''}"><strong>${loginJob.status === 'authenticated' ? 'Codex sign-in completed' : loginJob.status === 'user_action_needed' ? 'Finish sign-in with OpenAI' : esc(loginJob.status)}</strong>${verification && pending ? `<p>Open the official page and enter this code:</p><div class="as-device-code"><code>${esc(loginJob.userCode)}</code>${action('copy-login',icon('copy'),'aria-label="Copy device sign-in code"','as-icon-button')}</div><a class="as-button primary" href="${esc(verification)}" target="_blank" rel="noopener noreferrer">Continue to OpenAI ${icon('external')}</a>` : ''}${loginJob.error ? `<p>${esc(loginJob.error)}</p>` : ''}${pending ? action('cancel-login','Cancel sign-in','','as-link') : ''}<small>Codex owns the sign-in. Account tokens never enter Still.</small></div>`;
  }
  function providersView() {
    const preferences = getPreferences();
    return `${pairCard()}<div class="as-section-heading"><div><span class="as-eyebrow">ON THIS DEVICE</span><h3>Your coding companions</h3></div>${action('refresh',`${icon('restore')} Refresh`,'','as-link')}</div><div class="as-cli-grid">${cliCard('codex','Codex CLI','⌘','#7e967d')}${cliCard('claude','Claude Code','✳','#bd8d74')}</div><div class="as-section-heading"><div><span class="as-eyebrow">YOUR ACCOUNTS</span><h3>Connected API providers</h3></div><span class="as-hint">${config.providers.length} saved</span></div>${config.providers.length ? `<div class="as-saved-list">${config.providers.map(provider => { const definition = PROVIDERS.find(item => item.type === provider.type) || PROVIDERS[0]; return `<article class="as-saved-provider ${preferences.providerId === provider.id ? 'selected' : ''}">${logo(definition.mark,definition.color)}<div class="as-saved-info"><strong>${esc(provider.name)}</strong><span>${esc(provider.model || 'Choose a model ID')} · ${provider.hasCredentials ? 'Key saved locally' : ['ollama','lmstudio'].includes(provider.type) ? 'Local server' : 'No key saved'}</span></div><div class="as-saved-actions">${action('use-provider',preferences.providerId === provider.id ? icon('check') : 'Use',`data-id="${esc(provider.id)}" ${!provider.model ? 'disabled' : ''}`,`as-button ${preferences.providerId === provider.id ? 'selected' : ''}`)}${action('edit-provider',icon('edit'),`data-id="${esc(provider.id)}" aria-label="Edit ${esc(provider.name)}"`,'as-icon-button')}</div></article>`; }).join('')}</div>` : '<div class="as-empty-state">A model is a personal choice.<br><span>Add the provider that fits your way of working.</span></div>'}${['Cloud APIs','Compatible endpoints','On your device'].map(category => `<div class="as-section-heading compact"><h3>${category}</h3></div><div class="as-provider-grid">${PROVIDERS.filter(provider => provider.category === category).map(provider => action('add-provider',`${logo(provider.mark,provider.color)}<span><strong>${provider.name}</strong><small>${provider.description}</small></span>${icon('plus')}`,`data-type="${provider.type}"`,'as-provider-card')).join('')}</div>`).join('')}<p class="as-footnote">Saving a provider sends no inference request. “Test connection” only checks the provider’s model metadata. Your provider’s usage and billing apply when you send a request.</p>`;
  }
  function providerEditor() {
    const provider = editing; const definition = PROVIDERS.find(value => value.type === provider.type) || PROVIDERS[0];
    const values = provider.config || {}; const capabilities = provider.capabilities || {}; const aws = provider.type === 'bedrock', cloudflare = provider.type === 'cloudflare';
    const efforts = capabilities.reasoningEfforts || [];
    return `<div class="as-editor-heading">${action('back-providers',`${icon('back')} All providers`,'','as-link')}<div>${logo(definition.mark,definition.color)}<h3>${provider.id ? 'Make it your own.' : 'Meet your next thought partner.'}</h3></div><p>Choose the account and model you want Still to use.</p></div><form data-as-form="provider" class="as-provider-form" autocomplete="off"><div class="as-form-grid">${input('providerName','Connection name',provider.name || definition.name,'required maxlength="200"')}<label class="as-field">Provider protocol<select name="providerType" ${provider.id ? 'disabled' : ''}>${PROVIDERS.map(value => `<option value="${value.type}" ${value.type === provider.type ? 'selected' : ''}>${value.name}</option>`).join('')}</select></label></div>${input('baseUrl','API base URL',provider.baseUrl || definition.baseUrl,'type="url" required placeholder="https://your-endpoint.example/v1"')}<p class="as-footnote">HTTPS for remote providers. HTTP is supported for local loopback servers.</p>${cloudflare ? `<div class="as-form-grid">${input('accountId','Cloudflare account ID',values.accountId || '','required')}${input('apiToken','Cloudflare API token','','type="password" autocomplete="new-password" placeholder="Leave blank to keep the saved token"')}</div>` : aws ? `<div class="as-form-grid">${input('region','AWS region',values.region || 'us-east-1','required')}${input('profile','AWS profile',values.profile || '','placeholder="Default profile"')}</div>${check('useDefaultCredentials','Use the AWS CLI credential chain',values.useDefaultCredentials,'Resolve your chosen profile only when you test or send a request.')}<div class="as-aws-explicit" ${values.useDefaultCredentials ? 'hidden' : ''}><div class="as-form-grid">${input('accessKeyId','Access key ID','','autocomplete="off" placeholder="Leave blank to keep saved"')}${input('secretAccessKey','Secret access key','','type="password" autocomplete="new-password" placeholder="Leave blank to keep saved"')}</div>${input('sessionToken','Session token (optional)','','type="password" autocomplete="new-password" placeholder="For temporary AWS credentials"')}</div>` : input('apiKey',`${['ollama','lmstudio','openai-compatible','anthropic-compatible'].includes(provider.type) ? 'API key (optional)' : 'API key'}${provider.hasCredentials ? ' · saved key is kept if blank' : ''}`,'','type="password" autocomplete="new-password" placeholder="Your key stays in the encrypted local bridge"')}<div class="as-model-heading"><label class="as-field">Model ID<input name="model" list="as-discovered-models" value="${esc(provider.model || '')}" placeholder="Enter an exact model ID" maxlength="500"><datalist id="as-discovered-models"></datalist></label>${action('discover-models',`${icon('search')} Discover models`,`${provider.id ? '' : 'disabled'}`)}</div><p class="as-discovery-status as-footnote">${provider.id ? 'Discovery is an explicit network request. It does not test inference.' : 'Save the connection first to discover its available models. You can also enter a model ID manually.'}</p><details class="as-advanced" open><summary>Model controls <span>Only what your model supports</span>${icon('down')}</summary><div class="as-form-grid">${input('contextWindow','Context budget (tokens)',values.contextWindow || '','type="number" min="1" max="4000000" placeholder="Model default"')}${input('maxOutputTokens','Maximum output tokens',values.maxOutputTokens || 4096,'type="number" min="1" max="1000000" required')}</div>${check('images','This model supports image input',capabilities.images,'Send images only when you explicitly attach them to a request.')}${check('temperatureSupported','Enable temperature control',capabilities.temperature,'Leave off for models that do not accept temperature.')}<div class="as-form-grid">${input('temperature','Temperature',values.temperature ?? '',`type="number" min="0" max="2" step="0.05" placeholder="Provider default" ${capabilities.temperature ? '' : 'disabled'}`)}${input('supportedEfforts','Supported reasoning effort names',efforts.join(', '),'placeholder="e.g. low, medium, high"')}</div><label class="as-field">Default reasoning effort<select name="reasoningEffort"><option value="">Provider default</option>${efforts.map(effort => `<option value="${esc(effort)}" ${values.reasoningEffort === effort ? 'selected' : ''}>${esc(effort)}</option>`).join('')}</select></label>${aws ? `<label class="as-field">Model-specific Bedrock request fields (JSON)<textarea name="additionalModelRequestFields" rows="3" placeholder="{}">${esc(values.additionalModelRequestFields ? JSON.stringify(values.additionalModelRequestFields,null,2) : '')}</textarea></label>` : ''}<p class="as-footnote">Capabilities vary by model. These are your explicit settings; discovery does not silently enable controls or change your model.</p></details><div class="as-form-actions">${provider.id ? action('delete-provider',`${icon('trash')} Remove provider`,`data-id="${esc(provider.id)}"`,'as-link danger') : '<span></span>'}<div>${provider.id ? action('test-provider','Test metadata connection',`data-id="${esc(provider.id)}"`) : ''}<button class="as-button primary" type="submit">${icon('check')} Save connection</button></div></div></form>`;
  }
  function connectionPreview(clientId) {
    const preview = previews.get(clientId); if (!preview) return '';
    const receipt = receipts.get(clientId);
    return `<div class="as-connection-preview"><div class="as-preview-heading"><strong>Review the exact change</strong>${badge(preview.mode === 'native-cli' ? 'Native client command' : 'Configuration merge')}</div><label class="as-field">Configuration target<input value="${esc(preview.target || preview.configPath)}" readonly></label><div class="as-hash">Current file hash <code>${esc(preview.configHash || 'Not available')}</code></div><label class="as-field">Still MCP entry<textarea readonly rows="5" data-as-snippet="${clientId}">${esc(preview.configSnippet)}</textarea></label>${preview.commands?.length ? `<div class="as-command-preview"><strong>Command to be run</strong>${preview.commands.map(command => `<code>${esc(command.command)} ${esc(command.args.map(argument => JSON.stringify(argument)).join(' '))}</code>`).join('')}</div>` : ''}<p>${preview.backupRequired ? 'An exact local backup will be created before applying this change.' : 'This adds only the Still entry to the selected client.'} ${preview.reason ? esc(preview.reason) : ''}</p><div class="as-preview-actions">${action('copy-preview',`${icon('copy')} Copy snippet`,`data-id="${clientId}"`)}${preview.configured ? action('disconnect-client','Disconnect Still',`data-id="${clientId}"`,'as-button danger') : preview.canConnect ? action('connect-client',`${icon('plug')} Connect ${esc(preview.name)}`,`data-id="${clientId}"`,'as-button primary') : ''}</div>${receipt ? `<div class="as-receipt"><strong>${receipt.configured === true ? 'Configuration applied' : receipt.installed ? 'Skill installed' : 'Still entry removed'}</strong><p>Restart or reconnect the client to load the change. Runtime connection has not been verified.</p>${receipt.backupPath ? `<code>Backup: ${esc(receipt.backupPath)}</code>` : ''}${receipt.receiptPath ? `<code>Receipt: ${esc(receipt.receiptPath)}</code>` : ''}</div>` : ''}</div>`;
  }
  function mcpView() {
    return `${pairCard()}<div class="as-mcp-intro"><span class="as-mcp-orbit">${icon('plug')}</span><div><span class="as-eyebrow">MODEL CONTEXT PROTOCOL</span><h3>Bring your library to your agents.</h3><p>Search sources, read notes and propose changes through the same library you use here.</p></div></div><div class="as-server-endpoint"><label class="as-field">MCP server URL<input readonly value="${esc((integration.bridgeUrl || 'http://127.0.0.1:43123') + '/mcp')}" aria-label="MCP server URL"></label>${action('copy-mcp-url',icon('copy'),'aria-label="Copy MCP server URL"','as-icon-button')}${action('refresh',icon('restore'),'aria-label="Refresh MCP connection status"','as-icon-button')}</div><div class="as-mcp-facts"><div><strong>30 library tools</strong><span>Search, notes, highlights, collections and tasks</span></div><div><strong>Access is explicit</strong><span>Paired agents can read and update this library</span></div></div><p class="as-footnote">Configuration and a live connection are separate. “Configured” means the Still entry is present; it does not mean an agent has connected. Queued changes are saved only after the extension acknowledges them. Revision checks protect newer edits, and destructive tools require explicit confirmation.</p><div class="as-client-list">${clients.length ? clients.map(client => `<article class="as-client-card"><div class="as-card-heading">${logo(({codex:'⌘',claude:'✳',opencode:'OC',cursor:'↖',gemini:'✦'})[client.clientId || client.id] || '↔','#9b8aac')}<div><h4>${esc(client.name)}</h4><p>${esc(client.configPath || '')}</p></div>${badge(client.configured ? 'Configured' : client.configurationStatus === 'manual' ? 'Manual setup' : 'Not configured',client.configured ? 'positive' : '')}</div><div class="as-client-meta"><span>${client.runtimeConnected ? 'Runtime connection verified' : 'Runtime connection not verified'}</span><span>${client.skillInstalled ? 'Agent skill installed' : 'Agent skill not installed'}</span></div><div class="as-card-actions">${action('preview-client',`${icon('edit')} Review connection`,`data-id="${esc(client.clientId || client.id)}"`)}${action('install-skill',`${icon('note')} ${client.skillInstalled ? 'Verify installed skill' : 'Install agent skill'}`,`data-id="${esc(client.clientId || client.id)}"`)}${client.docs ? `<a class="as-link" href="${esc(client.docs)}" target="_blank" rel="noopener noreferrer">Client docs ↗</a>` : ''}</div>${connectionPreview(client.clientId || client.id)}</article>`).join('') : '<div class="as-empty-state">Pair the bridge to discover your agent connections.<br><span>Client settings are inspected only on this device.</span></div>'}</div><details class="as-manual-config"><summary>Manual MCP setup ${icon('down')}</summary><p>The local MCP server reads its bridge token from its own private config file.</p><label class="as-field">Streamable HTTP endpoint<input readonly value="${esc((integration.bridgeUrl || 'http://127.0.0.1:43123') + '/mcp')}"></label><p>HTTP clients need the private bearer token. The stdio configurations below keep that token out of client settings.</p><label class="as-field">Codex configuration<textarea readonly rows="4">${esc(setup.codex)}</textarea></label>${action('copy-codex','Copy Codex config')}<label class="as-field">Claude Desktop configuration<textarea readonly rows="8">${esc(setup.claude)}</textarea></label>${action('copy-claude','Copy Claude config')}</details>`;
  }
  function preferencesView() {
    const values = getPreferences();
    return `<div class="as-preferences-intro">${logo('✦','#9a86b6')}<h3>A voice that feels like yours.</h3><p>A few defaults for your writing companion.<br>You can change these for any conversation.</p></div><form data-as-form="preferences" class="as-defaults-form"><label class="as-field">Default tone<select name="tone">${[['natural','Natural'],['concise','Concise'],['professional','Professional'],['friendly','Friendly'],['academic','Academic']].map(([id,name]) => `<option value="${id}" ${values.tone === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label class="as-field">Response depth<select name="depth">${[['brief','Brief'],['balanced','Balanced'],['detailed','Detailed']].map(([id,name]) => `<option value="${id}" ${(values.depth || 'balanced') === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label class="as-field">Default source scope<select name="scope"><option value="selected" ${(values.scope || 'selected') === 'selected' ? 'selected' : ''}>Only the items I choose</option><option value="space" ${values.scope === 'space' ? 'selected' : ''}>Current space (when one is open)</option><option value="library" ${values.scope === 'library' ? 'selected' : ''}>Relevant items from my library</option></select></label><div class="as-privacy-note">${icon('lock')}<p>Your source documents stay reference material. Their contents cannot change application instructions, select a provider or authorize actions.</p></div><button type="submit" class="as-button primary">${icon('check')} Save writing defaults</button></form>`;
  }
  function render() {
    if (!dialog) return;
    for (const field of dialog.querySelectorAll('[data-as-agent-model]')) { const id = field.dataset.asAgentModel; cliDrafts.set(id,{ model: field.value, effort: dialog.querySelector(`[data-as-agent-effort="${id}"]`)?.value || '' }); }
    dialog.querySelectorAll('[data-tab]').forEach(element => { const selected = element.dataset.tab === tab; element.classList.toggle('active',selected); element.setAttribute('aria-selected',String(selected)); });
    dialog.querySelector('.as-content').innerHTML = editing ? providerEditor() : tab === 'mcp' ? mcpView() : tab === 'preferences' ? preferencesView() : providersView();
    if (!editing && tab === 'mcp') dialog.querySelector('.as-manual-config input[readonly]')?.closest('label').insertAdjacentHTML('afterend',action('copy-mcp-url',`${icon('copy')} Copy endpoint`));
    for (const [id,draft] of cliDrafts) { const field = dialog.querySelector(`[data-as-agent-model="${id}"]`), effort = dialog.querySelector(`[data-as-agent-effort="${id}"]`); if (field) field.value = draft.model; if (effort) effort.value = draft.effort; }
  }
  function updateEfforts(source) {
    const select = dialog.querySelector('[name="reasoningEffort"]'); if (!select) return;
    const selected = select.value; const efforts = [...new Set(source.split(',').map(value => value.trim()).filter(Boolean))];
    select.innerHTML = '<option value="">Provider default</option>' + efforts.map(effort => `<option value="${esc(effort)}" ${effort === selected ? 'selected' : ''}>${esc(effort)}</option>`).join('');
  }
  async function refresh() {
    const version = ++renderVersion;
    integration = await getIntegrationSettings();
    const results = await Promise.allSettled([client.configuration(), client.connections()]);
    if (version !== renderVersion || !dialog?.open) return;
    if (results[0].status === 'fulfilled') { config = { providers: listResult(results[0].value,'providers'), catalog: listResult(results[0].value,'catalog'), agents: listResult(results[0].value,'agents') };if(typeof results[0].value.runtime?.projectRoot==='string')Object.assign(setup,getMcpSetup(results[0].value.runtime.projectRoot)); connected = true; }
    else { connected = false; message(results[0].reason.message || 'Start and pair the local bridge to manage providers.','error'); }
    if (results[1].status === 'fulfilled') clients = listResult(results[1].value,'clients');
    else if (tab === 'mcp' && connected) message(results[1].reason.message,'error');
    if (!editing) render();
  }
  async function pollLogin() {
    clearTimeout(loginTimer);
    if (!dialog?.open || !loginJob || !['pending','user_action_needed'].includes(loginJob.status)) return;
    const id = loginJob.id;
    loginTimer = setTimeout(async () => {
      try {
        const result = await client.loginStatus(id); if (!dialog.open || loginJob?.id !== id) return;
        const previous = loginJob; loginJob = result.login || result;
        if (!editing && (previous.status !== loginJob.status || previous.userCode !== loginJob.userCode)) { const element = dialog.querySelector('.as-login-state'); if (element) element.outerHTML = renderLogin(); else render(); }
        if (loginJob.status === 'authenticated') { toast('Codex sign-in completed.'); const status = await client.authStatus(); Object.assign(auth,status.agents || status); if (dialog.open && !editing) render(); }
        pollLogin();
      } catch (error) { if (dialog.open) message(error.message,'error'); }
    }, 2000);
  }
  async function copy(value) { await navigator.clipboard.writeText(value); toast('Copied to clipboard.'); }
  async function handleAction(button) {
    const name = button.dataset.aiSettingsAction, id = button.dataset.id;
    if (name === 'close') return close();
    if (name === 'tab') { tab = button.dataset.tab; editing = null; message(); render(); return; }
    if (name === 'refresh') return busy(button,async () => { message(); await refresh(); });
    if (name === 'add-provider') { editing = { type: button.dataset.type }; message(); render(); return; }
    if (name === 'edit-provider') { editing = config.providers.find(provider => provider.id === id); message(); render(); return; }
    if (name === 'back-providers') { editing = null; message(); render(); return; }
    if (name === 'copy-start') return copy(setup.start);
    if (name === 'copy-login') return copy(loginJob?.userCode || '');
    if (name === 'copy-codex') return copy(setup.codex);
    if (name === 'copy-claude') return copy(setup.claude);
    if (name === 'copy-preview') return copy(previews.get(id)?.configSnippet || '');
    if (name === 'copy-mcp-url') return copy((integration.bridgeUrl || 'http://127.0.0.1:43123') + '/mcp');
    if (name === 'use-provider') {
      const provider = config.providers.find(provider => provider.id === id); if (!provider) return;
      await savePreferences({ providerId: id, model: provider.model, reasoningEffort: provider.config.reasoningEffort || '' }); await onProviderSelected(id,provider.model); toast(`${provider.name} selected.`); render(); return;
    }
    if (name === 'use-cli') {
      const model = dialog.querySelector(`[data-as-agent-model="${id}"]`).value.trim(), reasoningEffort = dialog.querySelector(`[data-as-agent-effort="${id}"]`).value;
      await savePreferences({ providerId: `cli:${id}`, model, reasoningEffort }); await onProviderSelected(`cli:${id}`,model); toast(`${id === 'codex' ? 'Codex' : 'Claude Code'} selected.`); render(); return;
    }
    if (name === 'check-auth') return busy(button,async () => { const result = await client.authStatus(); Object.assign(auth,result.agents || result); if (!editing) render(); });
    if (name === 'login') return busy(button,async () => { message(); const result = await client.startCodexLogin(); loginJob = result.login || result; render(); pollLogin(); });
    if (name === 'cancel-login') return busy(button,async () => { const result = await client.cancelLogin(loginJob.id); loginJob = result.login || result; clearTimeout(loginTimer); render(); });
    if (name === 'discover-models') return busy(button,async () => {
      const result = await client.models(editing.id); const models = listResult(result,'models'); const list = dialog.querySelector('#as-discovered-models'); if (!list) return;
      list.innerHTML = models.map(model => `<option value="${esc(model.id)}">${esc(model.name || model.id)}</option>`).join('');
      dialog.querySelector('.as-discovery-status').textContent = `${models.length} models returned by this endpoint. Choose an exact ID; capabilities remain your explicit choice.`;
      dialog.querySelector('[name="model"]').focus();
    });
    if (name === 'test-provider') return busy(button,async () => { const result = await client.testProvider(id); message(`Metadata connection succeeded. ${result.modelCount ?? result.models?.length ?? 0} models returned. Inference was not tested.`,'success'); });
    if (name === 'delete-provider') {
      const footer = button.closest('.as-form-actions'); if (!button.dataset.confirmed) { button.dataset.confirmed = 'true'; button.textContent = 'Confirm removal of this provider'; button.insertAdjacentHTML('afterend',action('cancel-delete','Keep provider','','as-link')); footer.querySelector('button[type="submit"]').disabled = true; message('Remove this provider connection and its saved credentials? Your notes and library are kept.'); return; }
      return busy(button,async () => { await client.deleteProvider(id); if (getPreferences().providerId === id) { await savePreferences({ providerId: '', model: '', reasoningEffort: '' }); await onProviderSelected('',''); } editing = null; toast('Provider connection removed.'); message(); await refresh(); });
    }
    if (name === 'cancel-delete') { const footer = button.closest('.as-form-actions'), remove = footer.querySelector('[data-ai-settings-action="delete-provider"]'); delete remove.dataset.confirmed; remove.innerHTML = `${icon('trash')} Remove provider`; footer.querySelector('button[type="submit"]').disabled = false; button.remove(); message(); return; }
    if (name === 'preview-client') return busy(button,async () => { const preview = await client.previewConnection(id); previews.set(id,preview); message(); render(); });
    if (name === 'connect-client' || name === 'disconnect-client') return busy(button,async () => {
      const preview = previews.get(id); if (!preview || typeof preview.previewHash !== 'string') throw new Error('Review a fresh connection preview first.');
      const receipt = await (name === 'connect-client' ? client.connect(id,preview.previewHash) : client.disconnect(id,preview.previewHash)); receipts.set(id,receipt);
      const fresh = await client.previewConnection(id); previews.set(id,fresh); await refresh();
      message(`${name === 'connect-client' ? 'Still configuration applied.' : 'Still entry removed.'} Restart or reconnect the client when ready; its runtime connection is not yet verified.`,'success');
    });
    if (name === 'install-skill') return busy(button,async () => { const receipt = await client.installSkills(id); receipts.set(id,receipt); await refresh(); message('The Still agent skill is installed. Restart or reload the client to discover it.','success'); });
  }
  async function handleSubmit(form) {
    const kind = form.dataset.asForm, data = new FormData(form), submit = form.querySelector('button[type="submit"]');
    if (kind === 'pair') return busy(submit,async () => {
      message(); const url = String(data.get('bridgeUrl')).trim(); const bridgeAddress = new URL(url);
      if (bridgeAddress.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(bridgeAddress.hostname) || bridgeAddress.username || bridgeAddress.password || bridgeAddress.pathname !== '/' || bridgeAddress.search || bridgeAddress.hash) throw new Error('Use an http loopback bridge address such as http://127.0.0.1:43123.');
      if (globalThis.chrome?.permissions?.request) { const origin = new URL(url); const allowed = await chrome.permissions.request({ origins: [`${origin.protocol}//${origin.hostname}/*`] }); if (!allowed) throw new Error('Allow the local bridge address to complete pairing.'); }
      await configureBridge({ url, token: String(data.get('bridgeToken')).trim(), enabled: true }); await syncBridgeOnce(); await onPair(); form.querySelector('[name="bridgeToken"]').value = ''; toast('Local bridge paired.'); await refresh();
    });
    if (kind === 'preferences') return busy(submit,async () => { await savePreferences({ tone: String(data.get('tone')), depth: String(data.get('depth')), scope: String(data.get('scope')) }); toast('Writing defaults saved.'); message('Your writing defaults are saved on this device.','success'); });
    if (kind === 'provider') return busy(submit,async () => {
      const type = editing.type; const effort = String(data.get('reasoningEffort') || ''); const temperatureSupported = data.get('temperatureSupported') === 'on';
      const providerConfig = { maxOutputTokens: Number(data.get('maxOutputTokens')), contextWindow: data.get('contextWindow') ? Number(data.get('contextWindow')) : null, reasoningEffort: effort || null, temperature: temperatureSupported && data.get('temperature') !== '' ? Number(data.get('temperature')) : null };
      const credentials = {};
      for (const key of ['apiKey','apiToken','accessKeyId','secretAccessKey','sessionToken']) if (data.get(key)) credentials[key] = String(data.get(key)).trim();
      if (type === 'cloudflare') providerConfig.accountId = String(data.get('accountId')).trim();
      if (type === 'bedrock') { providerConfig.region = String(data.get('region')).trim(); providerConfig.profile = String(data.get('profile') || '').trim(); providerConfig.useDefaultCredentials = data.get('useDefaultCredentials') === 'on'; const additional = String(data.get('additionalModelRequestFields') || '').trim(); providerConfig.additionalModelRequestFields = additional ? JSON.parse(additional) : null; }
      const result = await client.saveProvider({ ...(editing.id ? { id: editing.id } : {}), type, name: String(data.get('providerName')).trim(), baseUrl: String(data.get('baseUrl')).trim(), model: String(data.get('model') || '').trim(), config: providerConfig, capabilities: { images: data.get('images') === 'on', temperature: temperatureSupported, reasoningEfforts: String(data.get('supportedEfforts') || '').split(',').map(value => value.trim()).filter(Boolean) }, credentials });
      const saved = result.provider || result; editing = saved; toast('Provider connection saved.'); message('Saved locally. Discover models or test metadata when you are ready.','success');
      const response = await client.configuration(); config.providers = listResult(response,'providers');
      render();
    });
  }
  function open({ tab: selected = 'providers' } = {}) {
    ensureDialog(); tab = ['providers','mcp','preferences'].includes(selected) ? selected : 'providers'; editing = null; message(); render();
    if (!dialog.open) dialog.showModal(); refresh().catch(error => message(error.message,'error')); pollLogin();
  }
  function close() { clearTimeout(loginTimer); renderVersion++; if (dialog?.open) dialog.close(); }
  return { open, close, refresh };
}

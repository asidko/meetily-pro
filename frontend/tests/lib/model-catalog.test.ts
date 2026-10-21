import { describe, expect, test } from 'bun:test';
import { availability, keyProvider, loadProvider, readyGroups, type Call, type Catalog } from '../../src/lib/model-catalog';

function fakeCall(responses: Record<string, unknown>): { call: Call; calls: string[] } {
  const calls: string[] = [];
  const call = (async (command: string) => {
    calls.push(command);
    const response = responses[command];
    if (response instanceof Error) throw response;
    return response;
  }) as Call;
  return { call, calls };
}

const NO_INPUTS = { keys: {}, ollamaEndpoint: null };

describe('model catalog loading', () => {
  test('cloud provider without a key is not set up and never lists models', async () => {
    const { call, calls } = fakeCall({ get_openai_models: [{ id: 'gpt-4o' }] });
    expect(await loadProvider(call, 'openai', NO_INPUTS)).toEqual({ status: 'not-set-up', reason: 'No API key yet.' });
    expect(calls).toEqual([]);
  });

  test('cloud provider with a key lists its models', async () => {
    const { call } = fakeCall({ get_anthropic_models: [{ id: 'claude-sonnet-4-5' }] });
    expect(await loadProvider(call, 'claude', { keys: { claude: 'sk-ant' }, ollamaEndpoint: null }))
      .toEqual({ status: 'ready', models: ['claude-sonnet-4-5'] });
  });

  test('cloud speech models use the key saved for the same service', async () => {
    const { call, calls } = fakeCall({ get_cloud_speech_models: [{ id: 'gpt-transcribe' }, { id: 'gpt-4o-mini-transcribe' }] });
    expect(await loadProvider(call, 'openai-speech', NO_INPUTS)).toEqual({ status: 'not-set-up', reason: 'No API key yet.' });
    expect(calls).toEqual([]);
    expect(await loadProvider(call, 'openai-speech', { keys: { openai: 'sk-1' }, ollamaEndpoint: null }))
      .toEqual({ status: 'ready', models: ['gpt-transcribe', 'gpt-4o-mini-transcribe'] });
    expect(keyProvider('openrouter-speech')).toBe('openrouter');
    expect(keyProvider('groq')).toBe('groq');
    expect(keyProvider('parakeet')).toBeNull();
  });

  test('unreachable ollama is an error, not a missing setup', async () => {
    const { call } = fakeCall({ get_ollama_models: new Error('connection refused') });
    expect(await loadProvider(call, 'ollama', NO_INPUTS)).toEqual({ status: 'error', reason: 'connection refused' });
  });

  test('custom server needs both address and model', async () => {
    expect((await loadProvider(fakeCall({ api_get_custom_openai_config: { endpoint: 'http://x', model: '' } }).call, 'custom-openai', NO_INPUTS)).status)
      .toBe('not-set-up');
    expect(await loadProvider(fakeCall({ api_get_custom_openai_config: { endpoint: 'http://x', model: 'qwen3' } }).call, 'custom-openai', NO_INPUTS))
      .toEqual({ status: 'ready', models: ['qwen3'] });
  });

  test('coding agents are ready only when installed and signed in', async () => {
    const status = (installed: boolean, signedIn: boolean) => fakeCall({
      cli_agent_status: { installed, version: installed ? 'v2.1.0' : null, signedIn, models: signedIn ? ['sonnet', 'haiku'] : [] },
    }).call;
    expect(await loadProvider(status(false, false), 'claude-code', NO_INPUTS)).toEqual({ status: 'not-set-up', reason: 'Not installed.' });
    expect(await loadProvider(status(true, false), 'codex', NO_INPUTS)).toEqual({ status: 'not-set-up', reason: 'Installed, not signed in.' });
    expect(await loadProvider(status(true, true), 'claude-code', NO_INPUTS)).toEqual({ status: 'ready', models: ['sonnet', 'haiku'], detail: 'v2.1.0' });
  });

  test('on-device providers only offer finished downloads', async () => {
    const { call } = fakeCall({
      parakeet_get_available_models: [{ name: 'a', status: 'Available' }, { name: 'b', status: { Downloading: { progress: 4 } } }],
      builtin_ai_list_models: [{ name: 'gemma3:1b', status: { type: 'not_downloaded' } }],
    });
    expect(await loadProvider(call, 'parakeet', NO_INPUTS)).toEqual({ status: 'ready', models: ['a'] });
    expect((await loadProvider(call, 'builtin-ai', NO_INPUTS)).status).toBe('not-set-up');
  });
});

describe('model availability', () => {
  const catalog: Catalog = {
    ollama: { status: 'ready', models: ['gemma3:1b'] },
    claude: { status: 'not-set-up', reason: 'No API key yet.' },
    openai: { status: 'error', reason: 'offline' },
    'builtin-ai': { status: 'ready', models: ['qwen3.5:2b'] },
  };

  test('flags only what is known to be gone', () => {
    expect(availability(catalog, { provider: 'ollama', model: 'gemma3:1b' }).kind).toBe('ready');
    expect(availability(catalog, { provider: 'ollama', model: 'llama3' }).kind).toBe('gone');
    expect(availability(catalog, { provider: 'claude', model: 'claude-sonnet-4-5' }).kind).toBe('gone');
    expect(availability(catalog, { provider: 'openai', model: 'gpt-4o' }).kind).toBe('unknown');
    expect(availability(catalog, { provider: 'groq', model: 'llama' }).kind).toBe('checking');
    expect(availability(catalog, { provider: 'builtin-ai', model: 'gemma3:4b' })).toEqual({ kind: 'gone', reason: 'This model is not downloaded.' });
    expect(availability(catalog, { provider: 'builtin-ai', model: '' }).kind).toBe('none');
  });

  test('groups only ready providers in the given order', () => {
    expect(readyGroups(catalog, ['builtin-ai', 'claude', 'ollama']).map((g) => g.provider)).toEqual(['builtin-ai', 'ollama']);
  });
});

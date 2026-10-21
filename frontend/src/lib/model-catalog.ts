export type TextProvider = 'builtin-ai' | 'ollama' | 'openai' | 'claude' | 'groq' | 'openrouter' | 'custom-openai' | CliAgentProvider;
export const CLOUD_SPEECH = {
  'openai-speech': 'openai',
  'openrouter-speech': 'openrouter',
} as const;
export type CloudSpeechProvider = keyof typeof CLOUD_SPEECH;
export const CLOUD_SPEECH_PROVIDERS = Object.keys(CLOUD_SPEECH) as CloudSpeechProvider[];
export type SpeechProvider = 'parakeet' | 'localWhisper' | CloudSpeechProvider;
export type CatalogProvider = TextProvider | SpeechProvider;

export const SPEECH_PROVIDERS: SpeechProvider[] = ['parakeet', 'localWhisper', ...CLOUD_SPEECH_PROVIDERS];
export const CLI_AGENTS = ['claude-code', 'codex'] as const;
export type CliAgentProvider = typeof CLI_AGENTS[number];
export const TEXT_PROVIDERS: TextProvider[] = ['builtin-ai', 'ollama', 'openai', 'claude', 'groq', 'openrouter', 'custom-openai', ...CLI_AGENTS];
export const CLOUD_PROVIDERS = ['openai', 'claude', 'groq', 'openrouter'] as const;
export type CloudProvider = typeof CLOUD_PROVIDERS[number];

const LABELS: Record<CatalogProvider, string> = {
  parakeet: 'Parakeet',
  localWhisper: 'Whisper',
  'builtin-ai': 'Built-in AI',
  ollama: 'Ollama',
  openai: 'OpenAI',
  claude: 'Claude',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  'openai-speech': 'OpenAI',
  'openrouter-speech': 'OpenRouter',
  'custom-openai': 'Custom server',
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

export function catalogLabel(provider: string): string {
  return LABELS[provider as CatalogProvider] ?? provider;
}

export function isCloudSpeech(provider: string): provider is CloudSpeechProvider {
  return provider in CLOUD_SPEECH;
}

export function keyProvider(provider: string): CloudProvider | null {
  if (isCloudSpeech(provider)) return CLOUD_SPEECH[provider];
  return (CLOUD_PROVIDERS as readonly string[]).includes(provider) ? provider as CloudProvider : null;
}

export type ProviderState =
  | { status: 'loading' }
  | { status: 'ready'; models: string[]; detail?: string }
  | { status: 'not-set-up'; reason: string }
  | { status: 'error'; reason: string };

export type Catalog = Partial<Record<CatalogProvider, ProviderState>>;

export interface ModelChoice {
  provider: string;
  model: string;
}

export interface CatalogInputs {
  keys: Partial<Record<CloudProvider, string | null>>;
  ollamaEndpoint: string | null;
}

export type Call = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const CLOUD_LIST_COMMANDS: Record<CloudProvider, string> = {
  openai: 'get_openai_models',
  claude: 'get_anthropic_models',
  groq: 'get_groq_models',
  openrouter: 'get_openrouter_models',
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fromList(models: string[], emptyReason: string): ProviderState {
  return models.length > 0 ? { status: 'ready', models } : { status: 'not-set-up', reason: emptyReason };
}

async function loadSpeech(call: Call, command: string): Promise<ProviderState> {
  try {
    const models = await call<{ name: string; status: unknown }[]>(command);
    return fromList(models.filter((m) => m.status === 'Available').map((m) => m.name), 'No model downloaded yet.');
  } catch (error) {
    return { status: 'error', reason: errorText(error) };
  }
}

async function loadBuiltin(call: Call): Promise<ProviderState> {
  try {
    const models = await call<{ name: string; status: { type: string } }[]>('builtin_ai_list_models');
    return fromList(models.filter((m) => m.status?.type === 'available').map((m) => m.name), 'No model downloaded yet.');
  } catch (error) {
    return { status: 'error', reason: errorText(error) };
  }
}

async function loadOllama(call: Call, endpoint: string | null): Promise<ProviderState> {
  try {
    const models = await call<{ name: string }[]>('get_ollama_models', { endpoint });
    return fromList(models.map((m) => m.name), 'Ollama has no models yet.');
  } catch (error) {
    return { status: 'error', reason: errorText(error) };
  }
}

async function loadCloud(call: Call, command: string, args: Record<string, unknown>, key: string | null | undefined): Promise<ProviderState> {
  if (!key?.trim()) return { status: 'not-set-up', reason: 'No API key yet.' };
  try {
    const models = await call<{ id: string }[]>(command, { ...args, apiKey: key });
    return fromList(models.map((m) => m.id), 'No models returned.');
  } catch (error) {
    return { status: 'error', reason: errorText(error) };
  }
}

async function loadCustom(call: Call): Promise<ProviderState> {
  try {
    const config = await call<{ endpoint: string; model: string } | null>('api_get_custom_openai_config');
    if (!config?.endpoint || !config.model) return { status: 'not-set-up', reason: 'No server address and model yet.' };
    return { status: 'ready', models: [config.model] };
  } catch (error) {
    return { status: 'error', reason: errorText(error) };
  }
}

interface CliAgentStatus {
  installed: boolean;
  version: string | null;
  signedIn: boolean;
  models: string[];
}

async function loadCliAgent(call: Call, agent: CliAgentProvider): Promise<ProviderState> {
  try {
    const status = await call<CliAgentStatus>('cli_agent_status', { agent });
    if (!status.installed) return { status: 'not-set-up', reason: 'Not installed.' };
    if (!status.signedIn) return { status: 'not-set-up', reason: 'Installed, not signed in.' };
    return { status: 'ready', models: status.models, detail: status.version ?? undefined };
  } catch (error) {
    return { status: 'error', reason: errorText(error) };
  }
}

export async function loadProvider(call: Call, provider: CatalogProvider, inputs: CatalogInputs): Promise<ProviderState> {
  switch (provider) {
    case 'parakeet':
      return loadSpeech(call, 'parakeet_get_available_models');
    case 'localWhisper':
      return loadSpeech(call, 'whisper_get_available_models');
    case 'builtin-ai':
      return loadBuiltin(call);
    case 'ollama':
      return loadOllama(call, inputs.ollamaEndpoint);
    case 'custom-openai':
      return loadCustom(call);
    case 'claude-code':
    case 'codex':
      return loadCliAgent(call, provider);
    case 'openai-speech':
    case 'openrouter-speech':
      return loadCloud(call, 'get_cloud_speech_models', { provider }, inputs.keys[CLOUD_SPEECH[provider]]);
    default:
      return loadCloud(call, CLOUD_LIST_COMMANDS[provider], {}, inputs.keys[provider]);
  }
}

export function choiceKey(choice: ModelChoice): string {
  return `${choice.provider}:${choice.model}`;
}

export function readyGroups(catalog: Catalog, providers: CatalogProvider[]): { provider: CatalogProvider; models: string[] }[] {
  return providers.flatMap((provider) => {
    const state = catalog[provider];
    return state?.status === 'ready' ? [{ provider, models: state.models }] : [];
  });
}

export type Availability =
  | { kind: 'ready' }
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'gone'; reason: string };

const ON_DEVICE = new Set<string>(['parakeet', 'localWhisper', 'builtin-ai']);

export function isOnDevice(provider: string): boolean {
  return ON_DEVICE.has(provider);
}

export function isCliAgent(provider: string): provider is CliAgentProvider {
  return (CLI_AGENTS as readonly string[]).includes(provider);
}

export function availability(catalog: Catalog, choice: ModelChoice | null): Availability {
  if (!choice?.provider || !choice.model) return { kind: 'none' };
  const state = catalog[choice.provider as CatalogProvider];
  const label = catalogLabel(choice.provider);
  if (!state || state.status === 'loading') return { kind: 'checking' };
  if (state.status === 'error') return { kind: 'unknown', reason: `Could not reach ${label} to check this model. Your choice is kept.` };
  if (state.status === 'ready' && state.models.includes(choice.model)) return { kind: 'ready' };
  if (isOnDevice(choice.provider)) return { kind: 'gone', reason: 'This model is not downloaded.' };
  if (state.status === 'not-set-up') return { kind: 'gone', reason: `${label} is not set up. ${state.reason}` };
  return { kind: 'gone', reason: `${label} does not offer this model.` };
}

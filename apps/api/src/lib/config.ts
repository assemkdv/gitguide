// Every environment-driven setting in one place, parsed and validated once at startup
// (see index.ts). Values are read lazily through getConfig() so tests can change
// process.env and call resetConfigForTests().

export interface ApiConfig {
  isProduction: boolean;
  port: number;
  groqApiKey: string;
  githubToken: string | null;
  allowedExtensionIds: string[];
  /** Express 'trust proxy' value: number of reverse-proxy hops in front of the app. */
  trustProxyHops: number;
  enableLocalEmbeddings: boolean;
  models: { large: string; small: string };
  limits: {
    maxConcurrentAiRequests: number;
    aiQueueTimeoutMs: number;
    dailyAiRequestBudget: number;
    maxConcurrentIndexJobs: number;
    maxConcurrentBackgroundJobs: number;
    githubTimeoutMs: number;
    groqTimeoutMs: number;
  };
}

function intFromEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min} (got ${JSON.stringify(raw)})`);
  }
  return value;
}

export function loadConfig(): ApiConfig {
  const groqApiKey = (process.env.GROQ_API_KEY ?? '').trim();
  if (!groqApiKey) throw new Error('GROQ_API_KEY is not set.');

  return {
    isProduction: process.env.NODE_ENV === 'production',
    port: intFromEnv('PORT', 3000, 1),
    groqApiKey,
    githubToken: (process.env.GITHUB_TOKEN ?? '').trim() || null,
    // Tolerates bare ids or full "chrome-extension://<id>" origins pasted by mistake.
    allowedExtensionIds: (process.env.ALLOWED_EXTENSION_IDS ?? '')
      .split(',')
      .map((id) => id.trim().replace(/^chrome-extension:\/\//, '').replace(/\/$/, ''))
      .filter(Boolean),
    // Render terminates TLS at one load balancer in front of the service, which appends
    // the client address to X-Forwarded-For. Override if the deployment changes (e.g. an
    // extra CDN hop). Never use "true": that trusts any client-supplied header value.
    trustProxyHops: intFromEnv('TRUST_PROXY_HOPS', 1, 0),
    enableLocalEmbeddings: process.env.ENABLE_LOCAL_EMBEDDINGS === 'true',
    models: {
      large: process.env.GROQ_MODEL_LARGE?.trim() || 'openai/gpt-oss-120b',
      small: process.env.GROQ_MODEL_SMALL?.trim() || 'openai/gpt-oss-20b',
    },
    limits: {
      maxConcurrentAiRequests: intFromEnv('MAX_CONCURRENT_AI_REQUESTS', 6, 1),
      aiQueueTimeoutMs: intFromEnv('AI_QUEUE_TIMEOUT_MS', 15_000, 0),
      // In-memory, resets at UTC midnight and on restart. 0 disables the budget.
      dailyAiRequestBudget: intFromEnv('DAILY_AI_REQUEST_BUDGET', 3000, 0),
      maxConcurrentIndexJobs: intFromEnv('MAX_CONCURRENT_INDEX_JOBS', 2, 1),
      maxConcurrentBackgroundJobs: intFromEnv('MAX_CONCURRENT_BACKGROUND_JOBS', 1, 1),
      githubTimeoutMs: intFromEnv('GITHUB_TIMEOUT_MS', 10_000, 1000),
      groqTimeoutMs: intFromEnv('GROQ_TIMEOUT_MS', 60_000, 1000),
    },
  };
}

/** Human-readable startup warnings for settings that are legal but risky in production. */
export function configWarnings(config: ApiConfig): string[] {
  const warnings: string[] = [];
  if (config.isProduction && config.allowedExtensionIds.length === 0) {
    warnings.push(
      'ALLOWED_EXTENSION_IDS is empty: browsers will accept responses for any chrome-extension:// origin. ' +
        'Set it to the Web Store extension id. (This is not authentication; rate limits and budgets are the real abuse controls.)',
    );
  }
  if (!config.githubToken) {
    warnings.push('GITHUB_TOKEN is not set: GitHub allows only 60 unauthenticated API requests per hour for this server.');
  }
  return warnings;
}

let cached: ApiConfig | null = null;

export function getConfig(): ApiConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}

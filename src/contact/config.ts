export type ProviderName = 'resend' | 'slack' | 'teams' | 'log';
export const PROVIDERS: readonly ProviderName[] = ['resend', 'slack', 'teams', 'log'];

export interface ContactConfig {
  provider: ProviderName;
  turnstileSecretKey: string;
  turnstileFailOpen: boolean;
  toEmail?: string;
  fromEmail?: string;
  resendApiKey?: string;
  webhookUrl?: string;
}

/** Plain string settings: Worker vars and secrets, or process.env on any other host. */
export type ContactEnv = Record<string, string | undefined>;

export class ConfigError extends Error {
  readonly missing: string[];

  constructor(missing: string[], message: string) {
    super(message);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

/** Cloudflare's published Turnstile test secrets (always pass, always fail, token already spent). */
const TURNSTILE_TEST_SECRET = /^[123]x0{31}[A-Z]{2}$/;

const isProvider = (value: string): value is ProviderName => (PROVIDERS as readonly string[]).includes(value);

/** Reads and checks the settings the chosen provider needs, naming everything missing at once. */
export function readConfig(env: ContactEnv): ContactConfig {
  const missing: string[] = [];
  const need = (name: string): string => {
    const value = env[name]?.trim() ?? '';
    if (value === '') missing.push(name);
    return value;
  };

  const provider = env.DELIVERY_PROVIDER?.trim() ?? '';
  if (provider !== '' && !isProvider(provider)) {
    throw new ConfigError([], `DELIVERY_PROVIDER must be one of ${PROVIDERS.join(', ')}, not "${provider}".`);
  }
  if (provider === '') missing.push('DELIVERY_PROVIDER');

  const config: ContactConfig = {
    provider: provider as ProviderName,
    turnstileSecretKey: need('TURNSTILE_SECRET_KEY'),
    turnstileFailOpen: env.TURNSTILE_FAIL_OPEN?.trim().toLowerCase() === 'true',
  };
  if (provider === 'resend') {
    config.toEmail = need('CONTACT_TO_EMAIL');
    config.fromEmail = need('CONTACT_FROM_EMAIL');
    config.resendApiKey = need('RESEND_API_KEY');
  }
  if (provider === 'slack' || provider === 'teams') {
    config.webhookUrl = need('WEBHOOK_URL');
  }

  if (missing.length > 0) {
    throw new ConfigError(missing, `The contact form is missing configuration: ${missing.join(', ')}.`);
  }
  if (provider !== 'log' && TURNSTILE_TEST_SECRET.test(config.turnstileSecretKey)) {
    throw new ConfigError(
      [],
      'TURNSTILE_SECRET_KEY is a Turnstile test secret, which accepts every submission: delivery through ' +
        `"${provider}" needs a real one. Set it with \`npx wrangler secret put TURNSTILE_SECRET_KEY\`.`,
    );
  }
  if (config.webhookUrl !== undefined && !config.webhookUrl.startsWith('https://')) {
    throw new ConfigError([], 'WEBHOOK_URL must be an https URL.');
  }
  return config;
}

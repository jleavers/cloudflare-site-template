/**
 * The contact form's behaviour (contract C5). Markup lives in ContactForm.astro; this file keys
 * off its data-* hooks only, so a redesign never needs to touch it.
 *
 * Turnstile loads only when the form nears the viewport or gains focus, keeping pages free of
 * third-party JavaScript on first load. The submit button stays disabled until Turnstile issues
 * a token, and while a submission is in flight, so a double click sends one request.
 */
import { successText } from './success-message';

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface Turnstile {
  render(container: Element, options: Record<string, unknown>): string;
  reset(widgetId?: string): void;
}
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

type State = 'idle' | 'sending' | 'sent' | 'error';
interface ApiResponse {
  ok?: boolean;
  message?: string;
  errors?: Record<string, string>;
}

let loading: Promise<Turnstile> | undefined;
function loadTurnstile(): Promise<Turnstile> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not start')));
    script.onerror = () => reject(new Error('Turnstile could not load'));
    document.head.append(script);
  });
  return loading;
}

const withFallback = (text: string, email: string) => (email ? `${text} You can also email ${email}.` : text);

function clearErrors(form: HTMLFormElement): void {
  form.querySelectorAll<HTMLElement>('[data-error-for]').forEach((slot) => {
    slot.hidden = true;
    slot.textContent = '';
  });
  form.querySelectorAll('[aria-invalid]').forEach((element) => element.removeAttribute('aria-invalid'));
}

function showErrors(form: HTMLFormElement, errors: Record<string, string>): void {
  for (const [name, message] of Object.entries(errors)) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLElement) input.setAttribute('aria-invalid', 'true');
    const slot = form.querySelector<HTMLElement>(`[data-error-for="${CSS.escape(name)}"]`);
    if (slot) {
      slot.textContent = message;
      slot.hidden = false;
    }
  }
}

function setUp(form: HTMLFormElement): void {
  const button = form.querySelector<HTMLButtonElement>('[data-submit]');
  const status = form.querySelector<HTMLElement>('[data-status]');
  const container = form.querySelector<HTMLElement>('[data-turnstile]');
  if (!button || !status || !container) return;
  const successMessage = form.dataset.successMessage || 'Thank you — your message has been sent.';
  const fallbackEmail = form.dataset.fallbackEmail || '';

  let turnstile: Turnstile | undefined;
  let widgetId: string | undefined;
  let hasToken = false;
  let started = false;

  const setState = (state: State, message = '') => {
    form.dataset.state = state;
    status.textContent = message;
    button.disabled = state === 'sending' || !hasToken;
  };
  const consumeToken = () => {
    hasToken = false;
    turnstile?.reset(widgetId);
  };

  const start = () => {
    if (started) return;
    started = true;
    observer.disconnect();
    loadTurnstile()
      .then((api) => {
        turnstile = api;
        widgetId = api.render(container, {
          sitekey: container.dataset.sitekey,
          callback: () => {
            hasToken = true;
            if (form.dataset.state !== 'sending') button.disabled = false;
          },
          'expired-callback': () => {
            hasToken = false;
            button.disabled = true;
          },
          'error-callback': () => {
            hasToken = false;
            setState('error', withFallback('The spam check could not load. Please reload the page.', fallbackEmail));
          },
        });
      })
      .catch(() => setState('error', withFallback('The spam check could not load. Please reload the page.', fallbackEmail)));
  };
  const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && start(), {
    rootMargin: '200px',
  });
  observer.observe(form);
  form.addEventListener('focusin', start, { once: true });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (form.dataset.state === 'sending' || !hasToken) return;
    clearErrors(form);
    setState('sending', 'Sending…');
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      const body: ApiResponse = await response.json().catch(() => ({}));
      consumeToken();
      if (response.ok && body.ok) {
        const email = String(new FormData(form).get('email') ?? '');
        form.reset();
        setState('sent', successText(successMessage, email));
        return;
      }
      showErrors(form, body.errors ?? {});
      setState('error', body.message || withFallback('Sorry, something went wrong.', fallbackEmail));
    } catch {
      consumeToken();
      setState('error', withFallback('We couldn’t reach the server. Please check your connection and try again.', fallbackEmail));
    }
  });
}

export function initContactForms(root: ParentNode = document): void {
  root.querySelectorAll<HTMLFormElement>('form[data-contact-form]').forEach(setUp);
}

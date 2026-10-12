import type { Provider } from './types';

export function redactEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at > 0 ? `${email.slice(0, 1)}***${email.slice(at)}` : '***';
}

/**
 * Previews, local runs and the demo: proves the pipeline ran and sends nothing. It logs shapes,
 * not content, so a visitor's words never sit in a log.
 */
export const sendLog: Provider = async (submission, _config, { log }) => {
  log('info', 'contact: log provider, nothing sent', {
    email: redactEmail(submission.email),
    nameLength: submission.name.length,
    messageLength: submission.message.length,
  });
};

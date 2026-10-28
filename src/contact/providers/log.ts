import { formatLog } from './format';
import type { Provider } from './types';

/**
 * Previews, local runs and the demo: proves the pipeline ran and sends nothing. It logs shapes,
 * not content, so a visitor's words never sit in a log.
 */
export const sendLog: Provider = async (submission, _config, { log }) => {
  log('info', 'contact: log provider, nothing sent', formatLog(submission));
};

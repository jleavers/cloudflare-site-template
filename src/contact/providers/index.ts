import type { ProviderName } from '../config';
import { sendLog } from './log';
import { sendResend } from './resend';
import type { Provider } from './types';
import { sendSlack, sendTeams } from './webhook';

export const providers: Record<ProviderName, Provider> = {
  resend: sendResend,
  slack: sendSlack,
  teams: sendTeams,
  log: sendLog,
};

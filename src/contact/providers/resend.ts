import { formatText } from './format';
import { postJson, type Provider } from './types';

export const RESEND_URL = 'https://api.resend.com/emails';

/** Plain text only: no HTML body, so there is nothing for a visitor's input to inject into. */
export const sendResend: Provider = async (submission, config, { siteHost, fetch }) => {
  await postJson(
    fetch,
    RESEND_URL,
    {
      from: config.fromEmail,
      to: [config.toEmail],
      reply_to: submission.email,
      subject: `New enquiry from ${submission.name} via ${siteHost}`,
      text: formatText(submission, siteHost),
    },
    'Resend',
    { Authorization: `Bearer ${config.resendApiKey}` },
  );
};

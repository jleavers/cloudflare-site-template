import { formatSlack, formatTeams } from './format';
import { postJson, type Provider } from './types';

export const sendSlack: Provider = async (submission, config, { siteHost, fetch }) => {
  await postJson(fetch, config.webhookUrl as string, formatSlack(submission, siteHost), 'Slack');
};

/** A Teams Workflows webhook takes an Adaptive Card wrapped in a message (spike §16.2, Task 4). */
export const sendTeams: Provider = async (submission, config, { siteHost, fetch }) => {
  await postJson(
    fetch,
    config.webhookUrl as string,
    {
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: formatTeams(submission, siteHost) }],
    },
    'Teams',
  );
};

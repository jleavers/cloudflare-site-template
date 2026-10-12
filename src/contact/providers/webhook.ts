import { postJson, type Provider } from './types';

/** Slack treats &, < and > as control characters; escaped, a visitor cannot @-mention or link. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const sendSlack: Provider = async (submission, config, { siteHost, fetch }) => {
  const message = slackEscape(submission.message).replace(/```/g, "'''");
  const text = [
    `New enquiry via ${siteHost}`,
    `*Name:* ${slackEscape(submission.name)}`,
    `*Email:* ${slackEscape(submission.email)}`,
    '```' + message + '```',
  ].join('\n');
  await postJson(fetch, config.webhookUrl as string, { text }, 'Slack');
};

/** A Teams Workflows webhook takes an Adaptive Card wrapped in a message (spike §16.2, Task 4). */
export const sendTeams: Provider = async (submission, config, { siteHost, fetch }) => {
  const card = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: `New enquiry via ${siteHost}`, weight: 'Bolder', size: 'Medium', wrap: true },
      {
        type: 'FactSet',
        facts: [
          { title: 'Name', value: submission.name },
          { title: 'Email', value: submission.email },
        ],
      },
      { type: 'TextBlock', text: submission.message, wrap: true },
    ],
  };
  await postJson(
    fetch,
    config.webhookUrl as string,
    { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] },
    'Teams',
  );
};

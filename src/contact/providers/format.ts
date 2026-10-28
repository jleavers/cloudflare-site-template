import type { Submission } from '../validate';

// The one encoder (spec §7.4): it turns a validated submission into each destination's text, and
// every provider sends what it returns without reading a visitor field itself. validate() has
// already refused or stripped the characters that could hide text or reorder it; what is left
// here is each destination's markup.

export function formatText(submission: Submission, siteHost: string): string {
  return [
    `New enquiry via ${siteHost}`,
    '',
    `Name: ${submission.name}`,
    `Email: ${submission.email}`,
    '',
    submission.message,
  ].join('\n');
}

/** Resend: plain text only, so the body has no markup to escape; the subject and Reply-To are as validated. */
export function formatResend(submission: Submission, siteHost: string) {
  return {
    reply_to: submission.email,
    subject: `New enquiry from ${submission.name} via ${siteHost}`,
    text: formatText(submission, siteHost),
  };
}

/** Slack treats &, < and > as control characters; escaped, a visitor cannot @-mention or link. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A visitor field for Slack code: escaped, and with each backtick a quote, so it cannot close its code early. */
const slackCode = (text: string): string => slackEscape(text).replace(/`/g, "'");

/** Slack: each visitor field in code, which "will not use any other formatting" (Slack, Formatting message text). */
export function formatSlack(submission: Submission, siteHost: string) {
  return {
    text: [
      `New enquiry via ${siteHost}`,
      `*Name:* \`${slackCode(submission.name)}\``,
      `*Email:* \`${slackCode(submission.email)}\``,
      '```' + slackCode(submission.message) + '```',
    ].join('\n'),
  };
}

/**
 * Teams: TextBlock and FactSet parse a Markdown subset, and RichTextBlock "does not support
 * markdown" (Adaptive Cards, Text features), so each visitor field is TextRuns. A run ends between
 * two braces, so none holds the "{{" that starts a DATE() or TIME() function; adjacent runs read
 * as one text.
 */
const teamsRuns = (text: string) => text.split(/(?<=\{)(?=\{)/).map((part) => ({ type: 'TextRun', text: part }));

const teamsField = (label: string, value: string) => ({
  type: 'RichTextBlock',
  inlines: [{ type: 'TextRun', text: `${label}: `, weight: 'Bolder' }, ...teamsRuns(value)],
});

export function formatTeams(submission: Submission, siteHost: string) {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: `New enquiry via ${siteHost}`, weight: 'Bolder', size: 'Medium', wrap: true },
      teamsField('Name', submission.name),
      teamsField('Email', submission.email),
      { type: 'RichTextBlock', inlines: teamsRuns(submission.message) },
    ],
  };
}

export function redactEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at > 0 ? `${email.slice(0, 1)}***${email.slice(at)}` : '***';
}

/** log: shapes, not content, so a visitor's words never sit in a log. */
export function formatLog(submission: Submission) {
  return {
    email: redactEmail(submission.email),
    nameLength: submission.name.length,
    messageLength: submission.message.length,
  };
}

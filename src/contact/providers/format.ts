import type { Submission } from '../validate';

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

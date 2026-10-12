import { expect, test } from 'vitest';
import { site } from '../../src/config/site';
import { readDist } from './helpers';

test('the privacy page names every processor, the retention and the contact address', () => {
  const html = readDist('privacy/index.html');
  for (const processor of site.privacy.processors) expect(html).toContain(processor.name);
  expect(html).toContain(site.privacy.retention);
  expect(html).toContain(`mailto:${site.legal.privacyEmail}`);
});

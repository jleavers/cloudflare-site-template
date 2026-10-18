import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const workflow = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8').replaceAll('\r\n', '\n');

/**
 * ci.yml's jobs by name, each the text of its block without full-line comments. There is no YAML
 * parser among the dependencies, so this splits on the two-space job keys under `jobs:`.
 */
function jobBlocks(text: string): Map<string, string> {
  const body = text.split(/^jobs:\n/m)[1] ?? '';
  const keys = [...body.matchAll(/^ {2}([\w-]+):\n/gm)];
  if (keys.length === 0) throw new Error('found no jobs in ci.yml: has its layout changed?');
  return new Map(
    keys.map((key, i) => [
      key[1],
      body
        .slice(key.index, keys[i + 1]?.index)
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n'),
    ]),
  );
}

const jobs = jobBlocks(workflow);
const job = (name: string) => jobs.get(name) ?? '';
/** A job's steps, split on the six-space `- ` that starts each one. */
const steps = (block: string) => block.split(/^ {6}- /m).slice(1);
/** A job's own `if:`, folded or not. */
const condition = (block: string) => /^ {4}if:([\s\S]*?)^ {4}\w/m.exec(block)?.[1] ?? '';

// The jobs that hold the Cloudflare token, the environment each runs through, and the ref it trusts.
const TOKEN_JOBS = {
  deploy: { environment: 'production', ref: 'github.sha' },
  preview: { environment: 'preview', ref: 'github.event.pull_request.base.sha' },
  'preview-cleanup': { environment: 'preview', ref: 'github.event.pull_request.base.sha' },
};

test('the splitter finds every job', () => {
  expect([...jobs.keys()].sort()).toEqual(['deploy', 'e2e', 'preview', 'preview-build', 'preview-cleanup', 'verify']);
});

test('only the deploy and preview jobs can read the Cloudflare token', () => {
  const holders = [...jobs].filter(([, block]) => block.includes('secrets.CLOUDFLARE_API_TOKEN')).map(([name]) => name);
  expect(holders.sort()).toEqual(Object.keys(TOKEN_JOBS).sort());
});

describe.each(Object.entries(TOKEN_JOBS))('the %s job, which can read the token', (name, { environment, ref }) => {
  const block = job(name);
  const all = steps(block);
  const checkouts = all.filter((step) => step.includes('uses: actions/checkout@'));
  const wranglers = all.filter((step) => step.includes('uses: cloudflare/wrangler-action@'));

  test(`runs through the ${environment} environment`, () => {
    expect(block).toMatch(new RegExp(`^ {4}environment: ${environment}$`, 'm'));
  });

  test('installs, builds and tests nothing', () => {
    for (const command of ['npm ci', 'npm install', 'npm i ', 'npm run', 'npm test', 'npx ']) expect(block, command).not.toContain(command);
  });

  test('checks out only a sparse set of files, at the trusted ref, into a directory of their own', () => {
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) {
      expect(step).toContain(`ref: \${{ ${ref} }}`);
      expect(step).not.toContain('pull_request.head');
      expect(step).toContain('sparse-checkout:');
      expect(step).toContain('sparse-checkout-cone-mode: false');
      expect(step).toMatch(/^ {10}path: \S+$/m);
      expect(step).toContain('persist-credentials: false');
    }
  });

  test('runs scripts/trusted-config.mjs from the trusted checkout before wrangler, and gives wrangler its version', () => {
    const dir = /^ {10}path: (\S+)$/m.exec(checkouts[0] ?? '')?.[1];
    const trusted = all.findIndex((step) => step.includes(`run: node ${dir}/scripts/trusted-config.mjs ${dir}\n`));
    expect(trusted, 'the trusted-config step').toBeGreaterThan(all.indexOf(checkouts[0]!));
    const id = /^(?: {8})?id: (\S+)$/m.exec(all[trusted] ?? '')?.[1];
    expect(id, 'the trusted-config step has an id').toBeDefined();
    expect(wranglers.length).toBeGreaterThan(0);
    expect(all.indexOf(wranglers[0]!)).toBeGreaterThan(trusted);
    for (const step of wranglers) expect(step).toContain(`wranglerVersion: \${{ steps.${id}.outputs.wrangler-version }}`);
  });

  test('runs wrangler with no install scripts, from a directory of its own, on the trusted config', () => {
    const downloads = all.filter((step) => step.includes('uses: actions/download-artifact@'));
    const downloadPaths = downloads.map((step) => /^ {10}path: (.+)$/m.exec(step)?.[1]);
    for (const step of wranglers) {
      expect(step).toContain("npm_config_ignore_scripts: 'true'");
      const workingDirectory = /^ {10}workingDirectory: (.+)$/m.exec(step)?.[1];
      expect(workingDirectory).toBeDefined();
      expect(downloadPaths).not.toContain(workingDirectory);
      expect(step).toMatch(/^ {10}command: .* --config wrangler\.jsonc$/m);
    }
  });
});

test.each(['preview-build', 'preview', 'preview-cleanup'])('%s runs only when CI_PREVIEWS is true, for a pull request into the default branch', (name) => {
  const gate = condition(job(name));
  expect(gate).toContain("vars.CI_PREVIEWS == 'true'");
  expect(gate).toContain('github.event.pull_request.base.ref == github.event.repository.default_branch');
});

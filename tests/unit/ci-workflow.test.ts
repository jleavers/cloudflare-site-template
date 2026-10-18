import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), 'utf8').replaceAll('\r\n', '\n');

// GitHub runs every .yml and .yaml file in .github/workflows/, so every one is held to these rules.
const WORKFLOWS = new Map(
  readdirSync(root('.github/workflows'))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, read(`.github/workflows/${name}`)]),
);

/** A workflow's lines without full-line comments. Trailing comments stay: pins carry their version in one. */
const code = (text: string) => text.split('\n').filter((line) => !/^\s*#/.test(line));
/** The non-blank lines under `jobs:`. There is no YAML parser among the dependencies. */
const jobLines = (text: string) => {
  const lines = code(text);
  return lines.slice(lines.indexOf('jobs:') + 1).filter((line) => line.trim() !== '');
};
const JOB_KEY = /^ {2}[\w-]+:$/;

/** A workflow's jobs by name, each the text of its block, split on the two-space job keys. */
function jobBlocks(file: string, text: string): Map<string, string> {
  const lines = jobLines(text);
  const starts = lines.flatMap((line, i) => (JOB_KEY.test(line) ? [i] : []));
  if (starts.length === 0) throw new Error(`found no jobs in ${file}: has its layout changed?`);
  return new Map(starts.map((start, i) => [lines[start]!.trim().slice(0, -1), lines.slice(start, starts[i + 1]).join('\n')]));
}

const JOBS = new Map<string, string>(
  [...WORKFLOWS].flatMap(([file, text]) => [...jobBlocks(file, text)].map(([name, block]) => [`${file}:${name}`, block] as [string, string])),
);
const job = (name: string) => JOBS.get(name) ?? '';

/** A job's steps, split on the six-space `- ` that starts each one. */
const steps = (block: string) => block.split(/^ {6}- /m).slice(1);
/** A step's own scalar key (`uses`, `id`, `if`, `run`): on the step's first line, or at eight spaces. */
const stepValue = (step: string, key: string) => new RegExp(`^(?: {8})?${key}: (.*)$`, 'm').exec(step)?.[1];
/** The keys and values of a mapping (`with`, `env`) that sits `indent` spaces deep, one level down. */
function mapping(text: string, key: string, indent: number): Map<string, string> {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line === `${' '.repeat(indent)}${key}:` || (indent === 8 && line === `${key}:`));
  const out = new Map<string, string>();
  if (at === -1) return out;
  for (const line of lines.slice(at + 1)) {
    if (line.length - line.trimStart().length <= indent) break;
    const entry = new RegExp(`^ {${indent + 2}}([\\w-]+):(?: (.*))?$`).exec(line);
    if (entry) out.set(entry[1]!, entry[2] ?? '');
  }
  return out;
}
/** A block scalar's lines (`run: |`, `sparse-checkout: |`), dedented; or the plain value. */
function scalar(step: string, key: string, indent: number): string | undefined {
  const lines = step.split('\n');
  const at = lines.findIndex((line) => new RegExp(`^(?: {${indent}})?${key}:`).test(line));
  if (at === -1) return undefined;
  const value = lines[at]!.replace(new RegExp(`^(?: {${indent}})?${key}:\\s*`), '');
  if (!/^[|>]/.test(value)) return value;
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith(' '.repeat(indent + 2))) break;
    body.push(line.slice(indent + 2));
  }
  return body.join('\n');
}
/** A job's own `if:`, folded or not. */
const condition = (block: string) => /^ {4}if:([\s\S]*?)^ {4}\w/m.exec(block)?.[1] ?? '';
/** A step's action, without its pin: `actions/checkout`. */
const action = (step: string) => stepValue(step, 'uses')?.split('@')[0];

// A job holds the Cloudflare token if it names secrets at all (secrets.X, secrets['X'],
// toJSON(secrets), secrets: inherit), other than the GITHUB_TOKEN every job has.
const holdsSecrets = (block: string) => /\bsecrets\b(?!\.GITHUB_TOKEN\b)/i.test(block);

const COOLDOWN_DAYS = [...read('.github/dependabot.yml').matchAll(/default-days: (\d+)/g)].map((match) => match[1]);
const PIN = /^(actions\/[\w-]+|cloudflare\/wrangler-action)@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;
const RUNNER = "${{ vars.CI_LINUX_RUNNER || 'ubuntu-latest' }}";
// verify on a push to main builds the artifact that deploys, so it too runs on a GitHub-hosted runner.
const VERIFY_RUNNER = "${{ github.event_name == 'push' && 'ubuntu-latest' || vars.CI_LINUX_RUNNER || 'ubuntu-latest' }}";
const ENABLED = "env.HAS_CLOUDFLARE == 'true'";
const TRUSTED_FILES = ['/.nvmrc', '/package.json', '/scripts/trusted-config.mjs', '/wrangler.jsonc'];
const SITE = '${{ runner.temp }}/site';
const TRUSTED_CONFIG = 'node trusted/scripts/trusted-config.mjs trusted';
const VERSION_CHECK = 'test -n "$WRANGLER_VERSION" || { echo "::error::trusted-config.mjs gave no wrangler version"; exit 1; }';
// npm turns min-release-age into a `before` date. An npm that doesn't know the setting leaves
// `before` null, and would install with no floor.
const FLOOR_CHECK = [
  'before=$(npm config get before)',
  'test "$before" != null || { echo "::error::this npm ignores npm_config_min_release_age"; exit 1; }',
  'echo "npm takes only versions published before $before"',
].join('\n');
const COPY_SITE = [
  'mkdir -p "$RUNNER_TEMP/site/bundle"',
  'cp -R "$RUNNER_TEMP/artifact/dist" "$RUNNER_TEMP/site/dist"',
  'cp "$RUNNER_TEMP/artifact/bundle/worker.js" "$RUNNER_TEMP/site/bundle/worker.js"',
  'cp trusted/wrangler.jsonc "$RUNNER_TEMP/site/wrangler.jsonc"',
].join('\n');
const COPY_CONFIG = ['mkdir -p "$RUNNER_TEMP/site"', 'cp trusted/wrangler.jsonc "$RUNNER_TEMP/site/wrangler.jsonc"'].join('\n');
const NOTICE = /^echo "::notice title=\w+ skipped::[^"$`\\]*"$/;
// What each action may be given in a job that holds the token: a preCommands or a mirror would run
// or fetch something the trusted ref did not choose.
const INPUTS: Record<string, string[]> = {
  'actions/checkout': ['ref', 'path', 'sparse-checkout', 'sparse-checkout-cone-mode', 'persist-credentials'],
  'actions/setup-node': ['node-version-file', 'package-manager-cache'],
  'actions/download-artifact': ['name', 'path'],
  'actions/github-script': ['script'],
  'cloudflare/wrangler-action': ['apiToken', 'accountId', 'wranglerVersion', 'workingDirectory', 'command'],
};
const STEP_ENV = ['WRANGLER_VERSION', 'PREVIEW_URL', 'npm_config_ignore_scripts', 'npm_config_min_release_age'];

// The jobs that hold the token: the environment each runs through, the ref it trusts, the artifact
// it deploys, and its one wrangler command.
const TOKEN_JOBS = {
  'ci.yml:deploy': {
    environment: 'production',
    ref: '${{ github.sha }}',
    artifact: 'site',
    command: 'deploy bundle/worker.js --no-bundle --config wrangler.jsonc',
  },
  'ci.yml:preview': {
    environment: 'preview',
    ref: 'refs/heads/${{ github.event.repository.default_branch }}',
    artifact: 'preview-site',
    command: 'preview bundle/worker.js --name pr-${{ github.event.pull_request.number }} --config wrangler.jsonc',
  },
  'ci.yml:preview-cleanup': {
    environment: 'preview',
    ref: 'refs/heads/${{ github.event.repository.default_branch }}',
    artifact: undefined,
    command: 'preview delete --name pr-${{ github.event.pull_request.number }} --config wrangler.jsonc',
  },
};

describe.each([...WORKFLOWS])('%s', (file, text) => {
  // A workflow-level env reaches every job, the token jobs among them, and none of the job checks below.
  test('names no secrets, and sets no env, before jobs:', () => {
    const lines = code(text);
    const top = lines.slice(0, lines.indexOf('jobs:')).join('\n');
    expect(top).not.toMatch(/\bsecrets\b/i);
    expect(top).not.toMatch(/^env:/m);
  });

  test('has only two-space job keys under jobs:, with no trailing comment, and nothing after them at the top level', () => {
    for (const line of jobLines(text)) {
      expect(line, `${file}: ${line}`).toMatch(/^ {2}/);
      if (/^ {2}\S/.test(line)) expect(line, `${file}: ${line}`).toMatch(JOB_KEY);
    }
  });

  test('uses no YAML anchors or aliases, which would hide one job inside another', () => {
    for (const line of code(text)) expect(line, `${file}: ${line}`).not.toMatch(/(?:^|[\s[{,])[&*][\w-]/);
  });

  test('sets no workflow-wide defaults', () => expect(code(text).join('\n')).not.toMatch(/^defaults:/m));
});

test('the splitter finds every job in ci.yml', () => {
  expect([...JOBS.keys()].filter((name) => name.startsWith('ci.yml:')).sort()).toEqual(
    ['deploy', 'e2e', 'preview', 'preview-build', 'preview-cleanup', 'verify'].map((name) => `ci.yml:${name}`),
  );
});

test('only the deploy and preview jobs can read a secret', () => {
  const holders = [...JOBS].filter(([, block]) => holdsSecrets(block)).map(([name]) => name);
  expect(holders.sort()).toEqual(Object.keys(TOKEN_JOBS).sort());
});

test('the jobs without the token, but verify, run where CI_LINUX_RUNNER says', () => {
  for (const [name, block] of JOBS) if (!holdsSecrets(block) && name !== 'ci.yml:verify') expect(block, name).toContain(`\n    runs-on: ${RUNNER}\n`);
});

test('verify runs on a GitHub-hosted runner whenever it uploads the artifact that deploys', () => {
  expect(job('ci.yml:verify')).toContain(`\n    runs-on: ${VERIFY_RUNNER}\n`);
  const uploads = steps(job('ci.yml:verify')).filter((step) => action(step) === 'actions/upload-artifact');
  expect(uploads).toHaveLength(1);
  // the runner expression picks ubuntu-latest for every push; the upload needs a push.
  expect(stepValue(uploads[0]!, 'if')).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
});

test.each([
  ['ci.yml:verify', 'dist/\nbundle/'],
  ['ci.yml:preview-build', 'dist/\nbundle/'],
  ['ci.yml:e2e', 'test-results/\n.lighthouse/'],
])('%s uploads its files, hidden ones included', (name, paths) => {
  const uploads = steps(job(name)).filter((step) => action(step) === 'actions/upload-artifact');
  expect(uploads).toHaveLength(1);
  expect(mapping(uploads[0]!, 'with', 8).get('include-hidden-files')).toBe('true');
  expect(scalar(uploads[0]!, 'path', 10)).toBe(paths);
});

describe.each(Object.entries(TOKEN_JOBS))('the %s job, which holds the token', (name, expected) => {
  const block = job(name);
  const all = steps(block);
  const find = (actionName: string) => all.filter((step) => action(step) === actionName);
  const runs = all.flatMap((step) => {
    const script = scalar(step, 'run', 8);
    return script === undefined ? [] : [script];
  });
  const at = (predicate: (step: string) => boolean) => all.findIndex(predicate);
  const wranglers = find('cloudflare/wrangler-action');

  test(`runs through the ${expected.environment} environment, on a GitHub-hosted runner`, () => {
    expect(block).toContain(`\n    environment: ${expected.environment}\n`);
    // A persistent self-hosted runner keeps the tool cache and home directory that earlier jobs'
    // branch code ran beside.
    expect(block).toContain('\n    runs-on: ubuntu-latest\n');
  });

  // The checks below read keys by their plain block-style spelling, so nothing else may appear.
  test('is written in plain block style: no quoted keys, no flow collections, no commented block keys', () => {
    let scalarKeyIndent = -1; // the indentation of the key whose block scalar (| or >) we are inside
    for (const line of block.split('\n')) {
      const indent = line.length - line.trimStart().length;
      if (scalarKeyIndent >= 0 && indent > scalarKeyIndent) continue;
      scalarKeyIndent = /:\s*[|>][-+]?$/.test(line) ? indent + (/^\s*- /.test(line) ? 2 : 0) : -1;
      expect(line, line).not.toMatch(/^\s*(?:- )?["'][^"'\n]*["']\s*:/);
      // A flow value hides keys from the line-based reading; a job's needs list only holds job ids.
      if (!/^ {4}needs: \[[\w-]+(?:, [\w-]+)*\]$/.test(line)) expect(line, line).not.toMatch(/^\s*(?:- )?[\w-]+:\s*[{[]/);
      expect(line, line).not.toMatch(/^\s*(?:- )?(?:with|env|run|steps):\s*#/);
      if (indent === 4) expect(line, line).toMatch(/^ {4}[a-z][\w-]*:(?: .*)?$/);
      else if (indent === 6) expect(line, line).toMatch(/^ {6}(?:- [a-z][\w-]*|[A-Za-z_][\w-]*):(?: .*)?$/);
      else if (indent === 8) expect(line, line).toMatch(/^ {8}[a-z][\w-]*:(?: .*)?$/);
      else if (indent < 10) expect(line, line).toMatch(/^ {2}[\w-]+:$/);
    }
  });

  test('installs, builds and tests nothing, and runs only the shell it must', () => {
    for (const command of ['npm ci', 'npm install', 'npm i ', 'npm run', 'npm test', 'npx ']) expect(block, command).not.toContain(command);
    const allowed = [TRUSTED_CONFIG, VERSION_CHECK, FLOOR_CHECK, expected.artifact ? COPY_SITE : COPY_CONFIG];
    for (const script of runs) expect(allowed.includes(script) || NOTICE.test(script), script).toBe(true);
    for (const script of allowed) expect(runs, script).toContain(script);
  });

  test('has no container, services, shell, working-directory, defaults or continue-on-error', () => {
    expect(block).not.toMatch(/^\s*(container|services|shell|working-directory|defaults|continue-on-error):/m);
  });

  test('uses only pinned actions/* and cloudflare/wrangler-action, with only the inputs they need', () => {
    const uses = [...block.matchAll(/^\s*(?:- )?uses: (.*)$/gm)].map((match) => match[1]!);
    expect(uses.length).toBe(all.filter((step) => stepValue(step, 'uses')).length);
    for (const value of uses) expect(value).toMatch(PIN);
    for (const step of all.filter((step) => stepValue(step, 'uses'))) {
      const allowed = INPUTS[action(step)!];
      expect(allowed, `${action(step)} in a token job`).toBeDefined();
      for (const input of mapping(step, 'with', 8).keys()) expect(allowed, `${action(step)}: ${input}`).toContain(input);
    }
  });

  test('passes no environment but its own flags', () => {
    expect([...mapping(block, 'env', 4).keys()]).toEqual(['HAS_CLOUDFLARE']);
    for (const step of all) for (const key of mapping(step, 'env', 8).keys()) expect(STEP_ENV, key).toContain(key);
  });

  test('runs every step under the same condition, but the skip notice', () => {
    for (const step of all) {
      const script = scalar(step, 'run', 8);
      if (script !== undefined && NOTICE.test(script)) expect(stepValue(step, 'if')).toBe("env.HAS_CLOUDFLARE != 'true'");
      else expect(stepValue(step, 'if'), step.split('\n')[0]).toBe(ENABLED);
    }
  });

  test('checks out only the trusted files, at the trusted ref, into trusted/', () => {
    const checkouts = find('actions/checkout');
    expect(checkouts).toHaveLength(1);
    const inputs = mapping(checkouts[0]!, 'with', 8);
    expect(inputs.get('ref')).toBe(expected.ref);
    expect(inputs.get('path')).toBe('trusted');
    expect(scalar(checkouts[0]!, 'sparse-checkout', 10)?.split('\n')).toEqual(TRUSTED_FILES);
    expect(inputs.get('sparse-checkout-cone-mode')).toBe('false');
    expect(inputs.get('persist-credentials')).toBe('false');
    const setupNode = find('actions/setup-node');
    expect(setupNode).toHaveLength(1);
    expect(mapping(setupNode[0]!, 'with', 8).get('node-version-file')).toBe('trusted/.nvmrc');
    expect(mapping(setupNode[0]!, 'with', 8).get('package-manager-cache')).toBe('false');
  });

  test('refuses a custom build, and stops without a wrangler version, before wrangler runs', () => {
    const trusted = at((step) => scalar(step, 'run', 8) === TRUSTED_CONFIG);
    const check = at((step) => scalar(step, 'run', 8) === VERSION_CHECK);
    expect(trusted).toBeGreaterThan(at((step) => action(step) === 'actions/setup-node'));
    expect(at((step) => action(step) === 'actions/setup-node')).toBeGreaterThan(at((step) => action(step) === 'actions/checkout'));
    expect(stepValue(all[trusted]!, 'id')).toBe('trusted');
    expect(check).toBeGreaterThan(trusted);
    expect(mapping(all[check]!, 'env', 8).get('WRANGLER_VERSION')).toBe('${{ steps.trusted.outputs.wrangler-version }}');
    expect(wranglers.length).toBeGreaterThan(0);
    expect(all.indexOf(wranglers[0]!)).toBeGreaterThan(check);
  });

  test("stops unless the runner's npm applies the release-age floor, before wrangler runs", () => {
    const floor = at((step) => scalar(step, 'run', 8) === FLOOR_CHECK);
    expect(floor).toBeGreaterThan(at((step) => action(step) === 'actions/setup-node'));
    expect(all.indexOf(wranglers[0]!)).toBeGreaterThan(floor);
    expect(COOLDOWN_DAYS.length).toBeGreaterThan(0);
    for (const days of COOLDOWN_DAYS) expect(mapping(all[floor]!, 'env', 8).get('npm_config_min_release_age')).toBe(`'${days}'`);
  });

  test('copies only dist/ and bundle/worker.js from the artifact, into a fresh directory outside it', () => {
    const downloads = find('actions/download-artifact');
    expect(downloads).toHaveLength(expected.artifact ? 1 : 0);
    const downloadPaths = downloads.map((step) => mapping(step, 'with', 8).get('path') ?? '');
    for (const step of downloads) expect(mapping(step, 'with', 8).get('name')).toBe(expected.artifact);
    expect(downloadPaths.every((path) => path.startsWith('${{ runner.temp }}/'))).toBe(true);
    const sources = runs.flatMap((script) => [...script.matchAll(/^cp (?:-R )?(\S+) \S+$/gm)].map((match) => match[1]));
    expect(sources.sort()).toEqual(
      (expected.artifact ? ['"$RUNNER_TEMP/artifact/bundle/worker.js"', '"$RUNNER_TEMP/artifact/dist"', 'trusted/wrangler.jsonc'] : ['trusted/wrangler.jsonc']).sort(),
    );
    for (const step of wranglers) {
      const workingDirectory = mapping(step, 'with', 8).get('workingDirectory');
      expect(workingDirectory).toBe(SITE);
      for (const path of downloadPaths) {
        expect(`${workingDirectory}/`.startsWith(`${path}/`), `${workingDirectory} is inside ${path}`).toBe(false);
        expect(`${path}/`.startsWith(`${workingDirectory}/`), `${path} is inside ${workingDirectory}`).toBe(false);
      }
    }
  });

  test('runs its one wrangler command, at the trusted version, with no install scripts and a release-age floor', () => {
    expect(wranglers).toHaveLength(1);
    const inputs = mapping(wranglers[0]!, 'with', 8);
    expect(inputs.get('command')).toBe(expected.command);
    expect(inputs.get('wranglerVersion')).toBe('${{ steps.trusted.outputs.wrangler-version }}');
    expect(inputs.get('apiToken')).toBe('${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(inputs.get('accountId')).toBe('${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
    const env = mapping(wranglers[0]!, 'env', 8);
    expect(env.get('npm_config_ignore_scripts')).toBe("'true'");
    // The same floor as Dependabot's cooldown, for the ~35 packages wrangler-action installs
    // with no lockfile.
    expect(COOLDOWN_DAYS.length).toBeGreaterThan(0);
    for (const days of COOLDOWN_DAYS) expect(env.get('npm_config_min_release_age')).toBe(`'${days}'`);
  });
});

test.each(['ci.yml:preview-build', 'ci.yml:preview', 'ci.yml:preview-cleanup'])(
  '%s runs only when CI_PREVIEWS is true, for a pull request into the default branch',
  (name) => {
    const gate = condition(job(name));
    expect(gate).toContain("vars.CI_PREVIEWS == 'true'");
    expect(gate).toContain('github.event.pull_request.base.ref == github.event.repository.default_branch');
  },
);

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

// ---------------------------------------------------------------------------------------------
// The canonical subset. There is no YAML parser among the dependencies, so every workflow must be
// written in a subset of block YAML that the line-based reading below sees exactly as GitHub does.
// Outside block scalars (the lines under a `key: |` or `key: >-` header), a line is blank, a
// comment, `key:` or `key: value` with a bare key, or `- ` followed by one of those or by a value.
// Each nested block sits exactly two spaces under its key, and no mapping repeats a key. A value
// may not be a tag (!), anchor (&), alias (*), flow collection ({ or [) or complex key (?); a quoted
// value closes on its own line; and a double-quoted value holds no backslash, whose escapes could
// spell anything, `secrets` included.
// ---------------------------------------------------------------------------------------------

const KEY = /^([A-Za-z_][\w-]*):(?: (.*))?$/;
const BLOCK_SCALAR = /^[|>][-+]?$/;

/** What is wrong with a value after `key: ` or `- `, if anything. */
function valueError(value: string): string | undefined {
  if (BLOCK_SCALAR.test(value)) return undefined;
  if (/^\s/.test(value)) return 'more than one space before a value';
  if (/^[!&*{[?%@`|>#,]/.test(value)) return 'a tag, anchor, alias, flow collection, complex key, directive or comment in place of a value';
  if (/^-(?: |$)/.test(value)) return 'a sequence in place of a value';
  if (value.startsWith('"') && !/^"[^"\\]*"(?: +#.*)?$/.test(value)) return 'a double-quoted value with a backslash, or one that does not close on its line';
  if (value.startsWith("'") && !/^'(?:[^']|'')*'(?: +#.*)?$/.test(value)) return 'a single-quoted value that does not close on its line';
  return undefined;
}

/** Reads a workflow as the canonical subset: the lines outside it, and which lines are YAML comments. */
function readCanonical(file: string, text: string): { errors: string[]; comments: Set<number> } {
  const errors: string[] = [];
  const comments = new Set<number>();
  // The open blocks: each sequence or mapping, at its indentation, with the keys it has seen.
  const levels: { indent: number; sequence: boolean; keys: Set<string> }[] = [];
  let parent: number | undefined; // the column of a `key:` whose nested block may come next
  let scalarParent = -1; // the column of the key, or dash, whose block scalar this is
  text.split('\n').forEach((line, i) => {
    const fail = (why: string) => {
      errors.push(`${file}:${i + 1}: ${why}: ${line.trim()}`);
    };
    if (line.trim() === '') return;
    const indent = line.length - line.trimStart().length;
    if (scalarParent >= 0 && indent > scalarParent) return;
    scalarParent = -1;
    if (line.includes('\t')) return fail('a tab');
    if (line.trimStart().startsWith('#')) return void comments.add(i);
    const item = line.slice(indent).startsWith('- ');
    if (parent !== undefined && indent > parent) {
      if (indent !== parent + 2) fail('a nested block not indented two spaces under its key');
      levels.push({ indent, sequence: item, keys: new Set() });
    } else {
      while (levels.length > 0 && levels.at(-1)!.indent > indent) levels.pop();
      if (levels.length === 0 && indent === 0) levels.push({ indent, sequence: item, keys: new Set() });
      if (levels.at(-1)?.indent !== indent) return fail('an indentation that matches no open block');
    }
    parent = undefined;
    const level = levels.at(-1)!;
    if (level.sequence !== item) return fail(item ? 'a sequence item among keys' : 'a key among sequence items');
    let node = line.slice(indent);
    let column = indent;
    let keys = level.keys;
    if (item) {
      node = node.slice(2);
      column += 2;
      if (!KEY.test(node)) {
        const why = /^-(?: |$)/.test(node) ? 'a nested sequence' : valueError(node);
        if (why) return fail(why);
        if (BLOCK_SCALAR.test(node)) scalarParent = indent;
        return;
      }
      const mapping = { indent: column, sequence: false, keys: new Set<string>() };
      levels.push(mapping);
      keys = mapping.keys;
    }
    const [, key, value] = KEY.exec(node) ?? [];
    if (key === undefined) return fail('not a bare `key:` or `key: value`');
    if (keys.has(key)) return fail(`a second "${key}" in one mapping`);
    keys.add(key);
    if (value === undefined) {
      parent = column;
      return;
    }
    const why = valueError(value);
    if (why) return fail(why);
    if (BLOCK_SCALAR.test(value)) scalarParent = column;
  });
  return { errors, comments };
}

const CANONICAL = new Map([...WORKFLOWS].map(([file, text]) => [file, readCanonical(file, text)]));

/** A workflow's lines without its YAML comments. Block-scalar lines stay, `#` or not: GitHub reads them. */
const code = (file: string) =>
  WORKFLOWS.get(file)!
    .split('\n')
    .filter((_line, i) => !CANONICAL.get(file)!.comments.has(i));
/** The non-blank lines under `jobs:`. */
const jobLines = (file: string) => {
  const lines = code(file);
  return lines.slice(lines.indexOf('jobs:') + 1).filter((line) => line.trim() !== '');
};
const JOB_KEY = /^ {2}[\w-]+:$/;

/** A workflow's jobs by name, each the text of its block, split on the two-space job keys. */
function jobBlocks(file: string): Map<string, string> {
  const lines = jobLines(file);
  const starts = lines.flatMap((line, i) => (JOB_KEY.test(line) ? [i] : []));
  if (starts.length === 0) throw new Error(`found no jobs in ${file}: has its layout changed?`);
  return new Map(starts.map((start, i) => [lines[start]!.trim().slice(0, -1), lines.slice(start, starts[i + 1]).join('\n')]));
}

const JOBS = new Map<string, string>(
  [...WORKFLOWS.keys()].flatMap((file) => [...jobBlocks(file)].map(([name, block]) => [`${file}:${name}`, block] as [string, string])),
);
const job = (name: string) => JOBS.get(name) ?? '';

/** A job's steps: its `steps:` block, split on the six-space `- ` that starts each one. */
function steps(block: string): string[] {
  const lines = block.split('\n');
  const at = lines.indexOf('    steps:');
  if (at === -1) return [];
  const body = lines.slice(at + 1);
  const end = body.findIndex((line) => !line.startsWith('      '));
  return (end === -1 ? body : body.slice(0, end)).join('\n').split(/^ {6}- /m).slice(1);
}
/** A step's own scalar key (`uses`, `id`, `if`, `run`): on the step's first line, or at eight spaces. */
const stepValue = (step: string, key: string) => new RegExp(`^(?: {8})?${key}: (.*)$`, 'm').exec(step)?.[1];
/** The keys and values of a mapping (`with`, `env`, `outputs`) that sits `indent` spaces deep, one level down. */
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
/** A job's needs, as a scalar or a block sequence. */
function needs(block: string): string[] {
  const one = /^ {4}needs: (\S+)$/m.exec(block);
  if (one) return [one[1]!];
  const lines = block.split('\n');
  const at = lines.indexOf('    needs:');
  if (at === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const entry = /^ {6}- ([\w-]+)$/.exec(line);
    if (!entry) break;
    out.push(entry[1]!);
  }
  return out;
}
/** A job's own `if:`, folded or not. */
const condition = (block: string) => /^ {4}if:([\s\S]*?)^ {4}\w/m.exec(block)?.[1] ?? '';
/** A step's action, without its pin: `actions/checkout`. */
const action = (step: string) => stepValue(step, 'uses')?.split('@')[0];

// A job holds the Cloudflare token if it names secrets at all, in any form (secrets.X,
// secrets['X'], toJSON(secrets), secrets: inherit), other than the GITHUB_TOKEN every job has.
// The canonical subset keeps a reference from hiding behind a YAML escape.
const holdsSecrets = (text: string) => /\bsecrets\b(?!\.GITHUB_TOKEN\b)/i.test(text);

const COOLDOWN_DAYS = [...read('.github/dependabot.yml').matchAll(/default-days: (\d+)/g)].map((match) => match[1]);
const PIN = /^(actions\/[\w-]+|cloudflare\/wrangler-action)@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;
const TOP_LEVEL_KEYS = ['name', 'run-name', 'on', 'permissions', 'concurrency', 'jobs'];
const RUNNER = "${{ vars.CI_LINUX_RUNNER || 'ubuntu-latest' }}";
// verify on a push to main builds the artifact that deploys, so it too runs on a GitHub-hosted runner.
const VERIFY_RUNNER = "${{ github.event_name == 'push' && 'ubuntu-latest' || vars.CI_LINUX_RUNNER || 'ubuntu-latest' }}";
const ENABLED = "env.HAS_CLOUDFLARE == 'true'";
const TRUSTED_FILES = ['/.nvmrc', '/package.json', '/scripts/trusted-config.mjs', '/wrangler.jsonc'];
const SITE = '${{ runner.temp }}/site';
const TRUSTED_CONFIG = 'node trusted/scripts/trusted-config.mjs trusted';
const VERSION_CHECK = 'test -n "$WRANGLER_VERSION" || { echo "::error::trusted-config.mjs gave no wrangler version"; exit 1; }';
// npm 11.10.0 added min-release-age; an older npm only warns about it, and installs with no floor.
// No `npm config get` output tells a working npm 11.16+ from npm 10, so the check reads the version.
const FLOOR_CHECK = [
  "node -e '",
  '  const version = process.argv[1];',
  '  const parts = /^(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(version);',
  '  const [major, minor] = parts ? [Number(parts[1]), Number(parts[2])] : [NaN, NaN];',
  '  if (!(major > 11 || (major === 11 && minor >= 10))) {',
  '    console.log(`::error::npm ${version || "(no version)"} predates min-release-age (npm 11.10.0), so it would install with no floor`);',
  '    process.exit(1);',
  '  }',
  '  console.log(`npm ${version} applies min-release-age`);',
  `' "$(npm --version)"`,
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
// or fetch something the trusted ref did not choose, and a download by name could take a
// replacement artifact.
const INPUTS: Record<string, string[]> = {
  'actions/checkout': ['ref', 'path', 'sparse-checkout', 'sparse-checkout-cone-mode', 'persist-credentials'],
  'actions/setup-node': ['node-version-file', 'package-manager-cache'],
  'actions/download-artifact': ['artifact-ids', 'path'],
  'actions/github-script': ['script'],
  'cloudflare/wrangler-action': ['apiToken', 'accountId', 'wranglerVersion', 'workingDirectory', 'command'],
};
const STEP_ENV = ['WRANGLER_VERSION', 'PREVIEW_URL', 'npm_config_ignore_scripts', 'npm_config_min_release_age'];
const ARTIFACT_ID = '${{ steps.upload.outputs.artifact-id }}';

// The jobs that hold the token: the environment each runs through, the ref it trusts, the job whose
// artifact it deploys, and its one wrangler command.
const TOKEN_JOBS = {
  'ci.yml:deploy': {
    environment: 'production',
    ref: '${{ github.sha }}',
    builder: 'verify',
    command: 'deploy bundle/worker.js --no-bundle --config wrangler.jsonc',
  },
  'ci.yml:preview': {
    environment: 'preview',
    ref: 'refs/heads/${{ github.event.repository.default_branch }}',
    builder: 'preview-build',
    command: 'preview bundle/worker.js --name pr-${{ github.event.pull_request.number }} --config wrangler.jsonc',
  },
  'ci.yml:preview-cleanup': {
    environment: 'preview',
    ref: 'refs/heads/${{ github.event.repository.default_branch }}',
    builder: undefined,
    command: 'preview delete --name pr-${{ github.event.pull_request.number }} --config wrangler.jsonc',
  },
};

describe.each([...WORKFLOWS.keys()])('%s', (file) => {
  test('is written in the canonical block-YAML subset', () => {
    expect(CANONICAL.get(file)!.errors).toEqual([]);
  });

  // A workflow-level env reaches every job, the token jobs among them, and none of the job checks below.
  test('has only the expected top-level keys, and names no secrets before jobs:', () => {
    const lines = code(file);
    const top = lines.slice(0, lines.indexOf('jobs:'));
    for (const line of lines.filter((line) => /^\S/.test(line))) expect(TOP_LEVEL_KEYS, line).toContain(line.split(':')[0]);
    expect(holdsSecrets(top.join('\n'))).toBe(false);
  });

  test('has only two-space job keys under jobs:, and nothing after them at the top level', () => {
    for (const line of jobLines(file)) {
      expect(line, `${file}: ${line}`).toMatch(/^ {2}/);
      if (/^ {2}\S/.test(line)) expect(line, `${file}: ${line}`).toMatch(JOB_KEY);
    }
  });
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

test('verify runs on a GitHub-hosted runner, with no npm cache, whenever it uploads the artifact that deploys', () => {
  expect(job('ci.yml:verify')).toContain(`\n    runs-on: ${VERIFY_RUNNER}\n`);
  const uploads = steps(job('ci.yml:verify')).filter((step) => action(step) === 'actions/upload-artifact');
  expect(uploads).toHaveLength(1);
  // the runner expression picks ubuntu-latest for every push; the upload needs a push.
  expect(stepValue(uploads[0]!, 'if')).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
  // e2e on main runs on the self-hosted runner, and could save an npm cache there.
  const setupNode = steps(job('ci.yml:verify')).filter((step) => action(step) === 'actions/setup-node');
  expect(setupNode).toHaveLength(1);
  expect(mapping(setupNode[0]!, 'with', 8).get('cache')).toBe("${{ github.event_name != 'push' && 'npm' || '' }}");
  expect(mapping(setupNode[0]!, 'with', 8).get('package-manager-cache')).toBe('false');
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

test.each(['ci.yml:verify', 'ci.yml:preview-build'])("%s hands on its upload's artifact ID as a job output", (name) => {
  const uploads = steps(job(name)).filter((step) => action(step) === 'actions/upload-artifact');
  expect(stepValue(uploads[0]!, 'id')).toBe('upload');
  expect([...mapping(job(name), 'outputs', 4)]).toEqual([['site-artifact-id', ARTIFACT_ID]]);
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

  test('installs, builds and tests nothing, and runs only the shell it must', () => {
    for (const command of ['npm ci', 'npm install', 'npm i ', 'npm run', 'npm test', 'npx ']) expect(block, command).not.toContain(command);
    const allowed = [TRUSTED_CONFIG, VERSION_CHECK, FLOOR_CHECK, expected.builder ? COPY_SITE : COPY_CONFIG];
    for (const script of runs) expect(allowed.includes(script) || NOTICE.test(script), script).toBe(true);
    for (const script of allowed) expect(runs, script).toContain(script);
  });

  test('has no container, services, shell, working-directory, defaults, outputs or continue-on-error', () => {
    expect(block).not.toMatch(/^\s*(?:- )?(container|services|shell|working-directory|defaults|outputs|continue-on-error):/m);
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

  test("stops unless the runner's npm knows the release-age floor, before wrangler runs", () => {
    const floor = at((step) => scalar(step, 'run', 8) === FLOOR_CHECK);
    expect(floor).toBeGreaterThan(at((step) => action(step) === 'actions/setup-node'));
    expect(all.indexOf(wranglers[0]!)).toBeGreaterThan(floor);
  });

  test('downloads its artifact by the ID its builder uploaded, and copies only dist/ and bundle/worker.js out of it', () => {
    const downloads = find('actions/download-artifact');
    expect(downloads).toHaveLength(expected.builder ? 1 : 0);
    if (expected.builder) {
      expect(needs(block)).toContain(expected.builder);
      expect(mapping(downloads[0]!, 'with', 8).get('artifact-ids')).toBe(`\${{ needs.${expected.builder}.outputs.site-artifact-id }}`);
      expect(mapping(downloads[0]!, 'with', 8).has('name')).toBe(false);
    }
    const downloadPaths = downloads.map((step) => mapping(step, 'with', 8).get('path') ?? '');
    expect(downloadPaths.every((path) => path.startsWith('${{ runner.temp }}/'))).toBe(true);
    const sources = runs.flatMap((script) => [...script.matchAll(/^cp (?:-R )?(\S+) \S+$/gm)].map((match) => match[1]));
    expect(sources.sort()).toEqual(
      (expected.builder ? ['"$RUNNER_TEMP/artifact/bundle/worker.js"', '"$RUNNER_TEMP/artifact/dist"', 'trusted/wrangler.jsonc'] : ['trusted/wrangler.jsonc']).sort(),
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

// The canonical reader itself, on the spellings that would otherwise slip past the line-based checks.
describe('the canonical reader', () => {
  const errors = (text: string) => readCanonical('t.yml', text).errors;
  const ok = 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: x\n        run: |\n          # a shell comment\n          echo "${{ github.sha }}"\n        env:\n          A: \'b\'\n';

  test('accepts the canonical form', () => expect(errors(ok)).toEqual([]));

  test.each([
    ['a space before the colon', '        env:\n          NODE_OPTIONS : x\n'],
    ['a quoted key', '        env:\n          "NODE_OPTIONS": x\n'],
    ['a tag on a key', '        env:\n          !!str NODE_OPTIONS: x\n'],
    ['a complex key', '        with:\n          ? preCommands\n          : curl x | sh\n'],
    ['a tagged mapping', '        env: !!map\n          NODE_OPTIONS: x\n'],
    ['an anchor', '        env: &e\n          A: b\n'],
    ['an alias', '        env: *e\n'],
    ['a flow mapping', '        env: { NODE_OPTIONS: x }\n'],
    ['a flow sequence', '        needs: [a, b]\n'],
    ['an escape in a double-quoted value', '        env:\n          X: "${{ \\x73ecrets.T }}"\n'],
    ['a commented block key', '        with: # note\n          preCommands: x\n'],
    ['a nested block indented four spaces', '        with:\n            preCommands: x\n'],
    ['a second with in one step', '        with:\n          a: b\n        with:\n          preCommands: x\n'],
    ['a plain value carried onto a second line', '        run: echo a\n          b\n'],
    ['an indentless sequence', '        needs:\n        - a\n'],
    ['a block-scalar indentation indicator', '        run: |2\n            echo a\n'],
  ])('refuses %s', (_name, tail) => expect(errors(ok + tail)).not.toEqual([]));
});

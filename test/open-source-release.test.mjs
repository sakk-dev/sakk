import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The open-source release (CONTRIBUTING.md, SECURITY.md, .github/workflows):
 * one licence everywhere, the repository hooks off until a clone opts in, CI
 * that a fork pull request cannot turn against us, and a release that
 * publishes only from a public repository with provenance. Each check is a
 * function over file texts, run on the real files and on a planted mistake,
 * so a check that cannot fail fails here. Shell steps are run, not read.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const workflows = () =>
  Object.fromEntries(
    readdirSync(WORKFLOWS)
      .filter((f) => f.endsWith('.yml'))
      .map((f) => [f, readFileSync(join(WORKFLOWS, f), 'utf8')]),
  );
const FORK = 'github.event.pull_request.head.repo.full_name == github.repository';
// built at run time so this file is not itself a licence header the scan reads
const SPDX = ['SPDX', 'License', 'Identifier'].join('-');
const APACHE_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
/** The shell a step runs in, with only what a runner would give it. */
const BASE_PATH = [dirname(process.execPath), process.env.PATH ?? '/usr/bin:/bin'].join(':');

/** The jobs of a workflow, by name, each as its own text. */
function jobs(yml) {
  const at = yml.indexOf('\njobs:\n');
  assert.ok(at >= 0, 'a workflow without jobs');
  const out = {};
  let name = null;
  for (const line of yml.slice(at + 7).split('\n')) {
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (m) out[(name = m[1])] = '';
    else if (name) out[name] += line + '\n';
  }
  return out;
}

/** The `run: |` script that follows `marker`, dedented. */
function script(text, marker) {
  const lines = text.split('\n');
  let i = lines.findIndex((l) => l.includes(marker));
  assert.ok(i >= 0, `no step ${marker}`);
  while (!/^\s*run: \|\s*$/.test(lines[i])) i++;
  const indent = lines[i].search(/\S/);
  const body = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() && l.search(/\S/) <= indent) break;
    body.push(l);
  }
  const cut = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(cut)).join('\n');
}

const sh = (code, env, cwd) =>
  spawnSync('/bin/sh', ['-c', code], { cwd, encoding: 'utf8', env: { PATH: BASE_PATH, ...env } });
const tmp = (tag) => mkdtempSync(join(tmpdir(), `sakk-oss-${tag}-`));

// ---- licence -------------------------------------------------------------

/** Every file a commit of this tree would hold, tracked or new, as text. */
function treeFiles() {
  const list = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  );
  const files = new Map();
  for (const f of list.split('\0').filter(Boolean)) {
    if (existsSync(join(ROOT, f))) files.set(f, readFileSync(join(ROOT, f), 'utf8'));
  }
  return files;
}

function licenceProblems(files) {
  const bad = [];
  const sha = createHash('sha256')
    .update(files.get('LICENSE') ?? '')
    .digest('hex');
  if (sha !== APACHE_SHA256) bad.push(`LICENSE is not the Apache-2.0 text (sha256 ${sha})`);
  const notice = files.get('NOTICE') ?? '';
  if (!notice.startsWith('Sakk\nCopyright 2026 The Sakk authors\n'))
    bad.push('NOTICE does not open with Sakk and its authors');
  if (!notice.includes('Apache License, Version 2.0'))
    bad.push('NOTICE does not name the Apache License, Version 2.0');
  const json = (f) => JSON.parse(files.get(f) ?? '{}');
  if (json('package.json').license !== 'Apache-2.0') bad.push('package.json licence');
  if (json('.claude-plugin/plugin.json').license !== 'Apache-2.0') bad.push('plugin.json licence');
  for (const p of json('.claude-plugin/marketplace.json').plugins ?? [{}])
    if (p.license !== 'Apache-2.0') bad.push(`marketplace.json licence of ${p.name}`);
  let headers = 0;
  // the identifier, then the rest of its line: `Apache-2.0 OR MIT` is not Apache-2.0
  const line = new RegExp(`${SPDX}:[ \\t]*([A-Za-z0-9.+-]*)([^\\n]*)`, 'g');
  for (const [f, text] of files) {
    for (const m of text.matchAll(line)) {
      headers++;
      if (m[1] !== 'Apache-2.0' || /\b(OR|AND|WITH)\b/.test(m[2]))
        bad.push(`${f}: licence header ${`${m[1]}${m[2]}`.trim() || '(empty)'}`);
    }
  }
  if (headers < 2) bad.push(`only ${headers} licence header(s) found — the scan read nothing`);
  return bad;
}

// The terms a reader meets before LICENSE: the README's License section, the
// contributing guide and the pull request checklist.
const TERMS_DOCS = ['README.md', 'CONTRIBUTING.md', '.github/PULL_REQUEST_TEMPLATE.md'];

function termsProblems(files) {
  const bad = [];
  const readme = files.get('README.md') ?? '';
  const section = /^## License\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(readme)?.[1].trim() ?? '';
  if (!section.startsWith('Apache-2.0'))
    bad.push('README License section does not open with Apache-2.0');
  for (const f of TERMS_DOCS) {
    const text = files.get(f);
    if (text === undefined) {
      bad.push(`${f} is missing`);
      continue;
    }
    for (const [i, l] of text.split('\n').entries()) {
      if (/\b(?:A|L)?GPL\b|\bGPL-\d/.test(l)) bad.push(`${f}:${i + 1} names a GPL licence`);
      if (/\bCLA\b/.test(l) && !/\bno CLA\b/.test(l)) bad.push(`${f}:${i + 1} asks for a CLA`);
    }
  }
  if (!/Signed-off-by:/.test(files.get('CONTRIBUTING.md') ?? ''))
    bad.push('CONTRIBUTING.md does not show the DCO sign-off trailer');
  return bad;
}

describe('licence', () => {
  test('the licence is Apache-2.0 in LICENSE, NOTICE, both manifests and every SPDX header', () => {
    const files = treeFiles();
    assert.deepEqual(licenceProblems(files), []);
    // the headers the scan relies on are there to read
    for (const f of ['src/ledger.mjs', 'bin/sakk.mjs', 'scripts/dco-check.mjs'])
      assert.match(files.get(f), new RegExp(`${SPDX}: Apache-2\\.0`), f);
  });

  test('a planted AGPL header or a non-Apache LICENSE is caught by the licence scan', () => {
    const files = treeFiles();
    const agpl = new Map(files);
    agpl.set('src/planted.mjs', `// ${SPDX}: AGPL-3.0-only\nexport {};\n`);
    assert.deepEqual(licenceProblems(agpl), ['src/planted.mjs: licence header AGPL-3.0-only']);
    const dual = new Map(files);
    dual.set('src/dual.mjs', `/* ${SPDX}: Apache-2.0 OR MIT */\n`);
    assert.deepEqual(licenceProblems(dual), ['src/dual.mjs: licence header Apache-2.0 OR MIT */']);
    const mit = new Map(files);
    mit.set('LICENSE', files.get('LICENSE').replace('Apache License', 'MIT License'));
    assert.match(licenceProblems(mit).join('\n'), /LICENSE is not the Apache-2\.0 text/);
    const pkg = new Map(files);
    pkg.set('package.json', files.get('package.json').replace('"Apache-2.0"', '"AGPL-3.0-only"'));
    assert.deepEqual(licenceProblems(pkg), ['package.json licence']);
  });

  test('the README, the contributing guide and the PR checklist state Apache-2.0 and a DCO sign-off, no GPL or CLA', () => {
    assert.deepEqual(termsProblems(treeFiles()), []);
  });

  test('the old AGPL licence line, a CLA checkbox or a missing terms file is caught by the terms scan', () => {
    const files = treeFiles();
    const readme = files.get('README.md');
    const old = new Map(files);
    old.set(
      'README.md',
      readme.replace(
        /^## License\n\n.*$/m,
        '## License\n\nAGPL-3.0-only. Contributions require a CLA.',
      ),
    );
    const at =
      old.get('README.md').split('\n').indexOf('AGPL-3.0-only. Contributions require a CLA.') + 1;
    assert.deepEqual(termsProblems(old), [
      'README License section does not open with Apache-2.0',
      `README.md:${at} names a GPL licence`,
      `README.md:${at} asks for a CLA`,
    ]);
    const cla = new Map(files);
    cla.set(
      '.github/PULL_REQUEST_TEMPLATE.md',
      `${files.get('.github/PULL_REQUEST_TEMPLATE.md')}- [ ] CLA signed\n`,
    );
    assert.match(
      termsProblems(cla).join('\n'),
      /^\.github\/PULL_REQUEST_TEMPLATE\.md:\d+ asks for a CLA$/,
    );
    const gone = new Map(files);
    gone.delete('CONTRIBUTING.md');
    assert.deepEqual(termsProblems(gone), [
      'CONTRIBUTING.md is missing',
      'CONTRIBUTING.md does not show the DCO sign-off trailer',
    ]);
  });
});

// ---- repository hooks ----------------------------------------------------

describe('repository hooks', () => {
  test('the repository Claude Code hooks run only in a clone that opted in, and then still block', () => {
    const settings = JSON.parse(read('.claude/settings.json'));
    const gate = JSON.parse(read('scripts/gate-files.json'));
    const pre = settings.hooks.PreToolUse;
    // the parent dispatcher and this file must agree on what the gate sees
    assert.equal(pre.length, 1);
    assert.equal(pre[0].matcher, gate.hooks.PreToolUse[0].matcher);
    const commands = [
      ['PreToolUse', pre[0].hooks[0].command, 'findings-check.mjs --edit'],
      ['Stop', settings.hooks.Stop[0].hooks[0].command, 'stop-gate.sh'],
    ];
    assert.equal(
      Object.keys(settings.hooks).length,
      commands.length,
      'a hook without an opt-in test',
    );

    const d = tmp('hooks');
    const wt = join(tmp('hooks-wt'), 'wt');
    try {
      const git = (...a) =>
        execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd: d, encoding: 'utf8' });
      git('init', '-q');
      git('config', 'user.name', 'A Dev');
      git('config', 'user.email', 'dev@example.com');
      mkdirSync(join(d, 'scripts'));
      // stand-ins for the gate: each leaves a mark and blocks
      writeFileSync(
        join(d, 'scripts', 'findings-check.mjs'),
        "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.MARK, process.argv.slice(2).join(' '));\nprocess.exit(2);\n",
      );
      writeFileSync(join(d, 'scripts', 'stop-gate.sh'), 'printf stop > "$MARK"\nexit 2\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'stand-ins');

      const fire = (dir, command, tag) => {
        const mark = join(dirname(wt), `${tag}.mark`);
        rmSync(mark, { force: true });
        // no global or system git config: only this clone's own setting decides
        const r = sh(
          command,
          {
            CLAUDE_PROJECT_DIR: dir,
            MARK: mark,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
          },
          dir,
        );
        return { status: r.status, ran: existsSync(mark), stderr: r.stderr };
      };

      for (const [event, command] of commands) {
        const off = fire(d, command, `off-${event}`);
        assert.deepEqual(
          [off.status, off.ran],
          [0, false],
          `${event} ran in a clone that never opted in: ${off.stderr}`,
        );
      }
      git('config', 'core.hooksPath', 'scripts/hooks');
      git('worktree', 'add', '-q', wt);
      for (const dir of [d, wt]) {
        for (const [event, command] of commands) {
          const on = fire(dir, command, `on-${event}`);
          assert.deepEqual(
            [on.status, on.ran],
            [2, true],
            `${event} in ${dir === d ? 'the clone' : 'its worktree'}: ${on.stderr}`,
          );
        }
      }
      // any other value is not opting in
      git('config', 'core.hooksPath', '.git/hooks');
      for (const [event, command] of commands)
        assert.equal(fire(d, command, `other-${event}`).ran, false, event);
    } finally {
      rmSync(d, { recursive: true, force: true });
      rmSync(dirname(wt), { recursive: true, force: true });
    }
  });

  test('installing the package runs nothing: no install lifecycle script, the hooks only on request', () => {
    const problems = (pkg) => {
      const s = pkg.scripts ?? {};
      const bad = [
        'preinstall',
        'install',
        'postinstall',
        'prepublish',
        'preprepare',
        'prepare',
        'postprepare',
      ]
        .filter((k) => k in s)
        .map((k) => `a ${k} script runs on install`);
      if (s.hooks !== 'node scripts/hooks/install.mjs')
        bad.push('npm run hooks does not install the hooks');
      return bad;
    };
    const pkg = JSON.parse(read('package.json'));
    assert.deepEqual(problems(pkg), []);
    assert.deepEqual(problems({ ...pkg, scripts: { ...pkg.scripts, prepare: 'npm run hooks' } }), [
      'a prepare script runs on install',
    ]);
  });
});

// ---- one repository everywhere ------------------------------------------

function repositoryProblems(files) {
  const bad = [];
  const pkg = JSON.parse(files.get('package.json'));
  const plugin = JSON.parse(files.get('.claude-plugin/plugin.json'));
  const market = JSON.parse(files.get('.claude-plugin/marketplace.json'));
  const m = /^git\+https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\.git$/.exec(
    pkg.repository?.url ?? '',
  );
  if (!m) return [`package.json repository is not a GitHub URL: ${pkg.repository?.url}`];
  const [owner, name] = [m[1], m[2]];
  const web = `https://github.com/${owner}/${name}`;
  const want = [
    ['package.json bugs', pkg.bugs?.url, `${web}/issues`],
    ['package.json homepage', pkg.homepage, `${web}#readme`],
    ['plugin.json homepage', plugin.homepage, `${web}#readme`],
    ['plugin.json repository', plugin.repository, `${web}.git`],
    ['plugin.json author', plugin.author?.url, `https://github.com/${owner}`],
    ['marketplace owner', market.owner?.url, `https://github.com/${owner}`],
  ];
  for (const p of market.plugins ?? []) {
    want.push([`marketplace ${p.name} homepage`, p.homepage, `${web}#readme`]);
    want.push([`marketplace ${p.name} repository`, p.repository, `${web}.git`]);
    want.push([`marketplace ${p.name} source`, p.source, './']);
    want.push([`marketplace ${p.name} name`, p.name, plugin.name]);
  }
  if (!market.plugins?.length) bad.push('the marketplace lists no plugin');
  for (const [what, got, expected] of want)
    if (got !== expected) bad.push(`${what}: ${got} is not ${expected}`);
  if (!files.get('SECURITY.md').includes(`(${web}/security/advisories/new)`))
    bad.push('SECURITY.md does not link this repository’s private vulnerability reporting');
  return bad;
}

describe('repository identity', () => {
  test('the marketplace, SECURITY.md and package.json all name the same repository', () => {
    const files = new Map(
      [
        'package.json',
        '.claude-plugin/plugin.json',
        '.claude-plugin/marketplace.json',
        'SECURITY.md',
      ].map((f) => [f, read(f)]),
    );
    assert.deepEqual(repositoryProblems(files), []);
    // the marketplace's source is this repository's own plugin
    assert.ok(existsSync(join(ROOT, '.claude-plugin', 'plugin.json')));
    const moved = new Map(files);
    moved.set(
      '.claude-plugin/marketplace.json',
      files.get('.claude-plugin/marketplace.json').replace('sakk-dev/sakk.git', 'someone/sakk.git'),
    );
    assert.deepEqual(repositoryProblems(moved), [
      'marketplace sakk repository: https://github.com/someone/sakk.git is not https://github.com/sakk-dev/sakk.git',
    ]);
    const security = new Map(files);
    security.set(
      'SECURITY.md',
      files.get('SECURITY.md').replaceAll('sakk-dev/sakk/security', 'other/sakk/security'),
    );
    assert.match(repositoryProblems(security).join('\n'), /SECURITY\.md does not link/);
  });
});

// ---- workflows -----------------------------------------------------------

/** The workflow text without comments, which may name what they forbid. */
const code = (yml) =>
  yml
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .map((l) => l.replace(/\s+#.*$/, ''))
    .join('\n');

/** pr-review.yml's key check, run as the runner would for one pull request. */
function reviewKey(yml, { sameRepo, key }) {
  const d = tmp('review-key');
  try {
    const out = join(d, 'out');
    writeFileSync(out, '');
    const env = { GITHUB_OUTPUT: out, SAME_REPO: sameRepo ? 'true' : 'false' };
    if (key) env.DEEPSEEK_API_KEY = 'fake-key-for-the-test';
    const r = sh(script(yml, '- id: key'), env, d);
    assert.equal(r.status, 0, r.stderr);
    return /^present=(\w+)$/m.exec(readFileSync(out, 'utf8'))?.[1];
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

describe('workflows', () => {
  test('no workflow runs on pull_request_target, and the review never runs for a fork or without its key', () => {
    for (const [f, yml] of Object.entries(workflows()))
      assert.doesNotMatch(code(yml), /pull_request_target/, `${f} runs on pull_request_target`);
    const yml = read('.github/workflows/pr-review.yml');
    assert.match(
      code(yml),
      /^permissions: \{\}$/m,
      'pr-review grants the token nothing by default',
    );
    assert.equal(reviewKey(yml, { sameRepo: false, key: true }), 'no', 'a fork with a key');
    assert.equal(reviewKey(yml, { sameRepo: false, key: false }), 'no', 'a fork without a key');
    assert.equal(
      reviewKey(yml, { sameRepo: true, key: false }),
      'no',
      'this repository without a key',
    );
    assert.equal(
      reviewKey(yml, { sameRepo: true, key: true }),
      'yes',
      'this repository with a key',
    );
    // the planted mistake: drop the fork test and a fork's run would review
    const open = yml.replace('[ "$SAME_REPO" != true ]', 'false');
    assert.notEqual(open, yml);
    assert.equal(reviewKey(open, { sameRepo: false, key: true }), 'yes');

    // the key check is told whether the run is a fork, and alone decides the review
    assert.ok(jobs(yml)['review-key'].includes(`SAME_REPO: \${{ ${FORK} }}`));
    const review = jobs(yml)['adversarial-review'];
    assert.match(review, /^ {4}if: needs\.review-key\.outputs\.present == 'yes'$/m);
    // the job holding the key reads the pull request as a diff, never runs its code
    assert.match(review, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    assert.doesNotMatch(code(review), /npm (ci|install|test)|node scripts|head\.sha/);
  });

  test('fork pull requests skip only the self-evolution and base-checker jobs; tests, format and DCO still run', () => {
    const problems = (yml) => {
      const all = jobs(yml);
      const bad = [];
      for (const j of ['test', 'format', 'drill', 'self-evolution', 'base-checker'])
        if (!(j in all)) bad.push(`no ${j} job`);
      const forkOnly = Object.keys(all).filter((j) => all[j].includes(FORK));
      if (forkOnly.sort().join() !== 'base-checker,self-evolution')
        bad.push(`the same-repository condition is on: ${forkOnly.join(', ') || 'nothing'}`);
      const fmt = all.format ?? '';
      if (!/fetch-depth: 0/.test(fmt))
        bad.push('format checks out one commit, so the DCO step sees none');
      const dco = fmt.slice(fmt.indexOf('DCO'));
      if (!fmt.includes('DCO')) bad.push('no DCO step');
      else {
        if (!dco.includes("if: ${{ !cancelled() && github.event_name == 'pull_request' }}"))
          bad.push('the DCO step does not run on every pull request');
        if (!dco.includes('git show "origin/$base:scripts/dco-check.mjs"'))
          bad.push('the DCO step does not run the base copy');
        if (!/node "\$dco" --range "origin\/\$base\.\.\$\{HEAD_SHA:\?/.test(dco))
          bad.push('the DCO step checks no range');
      }
      return bad;
    };
    const ci = read('.github/workflows/ci.yml');
    assert.deepEqual(problems(ci), []);
    // planted: a fork skips the tests, or the base-checker runs for a fork
    const skipsTests = ci.replace(/^ {2}test:\n/m, `  test:\n    if: ${FORK}\n`);
    assert.notEqual(skipsTests, ci);
    assert.deepEqual(problems(skipsTests), [
      'the same-repository condition is on: base-checker, self-evolution, test',
    ]);
    const lines = ci.split('\n');
    const at = lines.findIndex((l) => l.startsWith('  base-checker:'));
    const k = lines.findIndex((l, i) => i > at && l.includes(FORK));
    lines[k] = lines[k].replace(` && ${FORK}`, '');
    assert.deepEqual(problems(lines.join('\n')), [
      'the same-repository condition is on: self-evolution',
    ]);
  });

  test('every action is pinned to a full commit SHA, with its tag beside it', () => {
    const unpinned = (all) =>
      Object.entries(all).flatMap(([f, yml]) =>
        yml
          .split('\n')
          .filter(
            (l) =>
              /^\s*-?\s*uses:/.test(l) && !/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d\S*$/.test(l),
          )
          .map((l) => `${f}: ${l.trim()}`),
      );
    const all = workflows();
    assert.ok(Object.keys(all).length >= 4);
    assert.deepEqual(unpinned(all), []);
    const planted = { ...all, 'x.yml': '      - uses: actions/checkout@v4\n' };
    assert.deepEqual(unpinned(planted), ['x.yml: - uses: actions/checkout@v4']);
  });

  test('the scorecard runs weekly on a public repository only, inside what publish_results allows', () => {
    const problems = (yml) => {
      const c = code(yml);
      const bad = [];
      const on = /^on:\n((?: {2}.*\n|\s*\n)*)/m.exec(c)?.[1] ?? '';
      if (on.trim().split('\n')[0] !== 'schedule:' || /^ {2}(?!schedule:|\s)/m.test(on))
        bad.push('it runs on more than a schedule');
      if (!/^permissions: read-all$/m.test(c)) bad.push('top-level permissions are not read-all');
      if (/^(env|defaults):/m.test(c)) bad.push('top-level env or defaults');
      if (!c.includes('if: ${{ !github.event.repository.private }}'))
        bad.push('it runs while the repository is private');
      if (/^\s*(-\s*)?run:/m.test(c)) bad.push('a run step');
      const uses = [...c.matchAll(/uses: ([\w./-]+)@/g)].map((m) => m[1]);
      const allowed = [
        'actions/checkout',
        'ossf/scorecard-action',
        'github/codeql-action/upload-sarif',
      ];
      for (const u of uses)
        if (!allowed.includes(u)) bad.push(`an action publish_results refuses: ${u}`);
      if (!uses.includes('ossf/scorecard-action')) bad.push('no scorecard step');
      if (!/publish_results: true/.test(c)) bad.push('results are not published');
      return bad;
    };
    const yml = read('.github/workflows/scorecard.yml');
    assert.deepEqual(problems(yml), []);
    assert.deepEqual(problems(yml.replace('on:\n', 'on:\n  push:\n    branches: [main]\n')), [
      'it runs on more than a schedule',
    ]);
    assert.deepEqual(problems(yml.replace(/^ {4}if: .*\n/m, '')), [
      'it runs while the repository is private',
    ]);
  });

  test('the release publishes only from a public repository, on a tag matching package.json, with provenance', () => {
    const problems = (yml) => {
      const c = code(yml);
      const bad = [];
      if (!/^on:\n {2}push:\n {4}tags: \['v\*'\]\n(?!\s{2}\S)/m.test(c))
        bad.push('it runs on more than a v* tag');
      const guard = c.indexOf('- name: a public repository');
      const tests = c.indexOf('- run: npm test');
      const publish = c.indexOf('npm publish --provenance --access public');
      if (!(guard >= 0 && tests > guard && publish > tests))
        bad.push('the guard and the tests do not both come before the publish');
      if ((c.match(/npm publish/g) ?? []).length !== 1) bad.push('more than one publish');
      if (/secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN/.test(c))
        bad.push('it publishes with a stored token');
      if (!/^ {6}id-token: write$/m.test(c)) bad.push('no OIDC token for trusted publishing');
      if (!/registry-url: https:\/\/registry\.npmjs\.org$/m.test(c))
        bad.push('no registry for the OIDC exchange');
      if (/continue-on-error/.test(c)) bad.push('a step may fail without stopping the publish');
      return bad;
    };
    const yml = read('.github/workflows/release.yml');
    assert.deepEqual(problems(yml), []);
    assert.deepEqual(
      problems(
        yml
          .replace('      - run: npm test\n', '')
          .replace('--access public\n', '--access public\n      - run: npm test\n'),
      ),
      ['the guard and the tests do not both come before the publish'],
    );
    assert.deepEqual(
      problems(yml.replace('npm publish', 'NODE_AUTH_TOKEN=${{ secrets.NPM_TOKEN }} npm publish')),
      ['it publishes with a stored token'],
    );

    // the guard, run: public + matching tag + new npm is the only way through
    const guard = script(yml, '- name: a public repository');
    const d = tmp('release');
    try {
      writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.3' }));
      const bin = join(d, 'bin');
      mkdirSync(bin);
      const runGuard = ({ priv = 'false', tag = 'v1.2.3', npm = '11.6.0' }) => {
        writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho ${npm}\n`);
        chmodSync(join(bin, 'npm'), 0o755);
        const r = spawnSync('/bin/sh', ['-c', guard], {
          cwd: d,
          encoding: 'utf8',
          env: { PATH: `${bin}:${BASE_PATH}`, PRIVATE: priv, TAG: tag },
        });
        return { ok: r.status === 0, out: r.stdout + r.stderr };
      };
      const pass = (c) => assert.ok(runGuard(c).ok, `${JSON.stringify(c)}: ${runGuard(c).out}`);
      const fail = (c, why) => {
        const r = runGuard(c);
        assert.ok(!r.ok, `${JSON.stringify(c)} passed`);
        assert.match(r.out, why, JSON.stringify(c));
      };
      pass({});
      pass({ npm: '11.5.1' });
      pass({ npm: '12.0.0' });
      fail({ priv: 'true' }, /not public/);
      fail({ priv: '' }, /not public/);
      fail({ tag: 'v1.2.4' }, /is not v1\.2\.3/);
      fail({ tag: '1.2.3' }, /is not v1\.2\.3/);
      fail({ npm: '11.5.0' }, /older than 11\.5\.1/);
      fail({ npm: '10.9.2' }, /older than 11\.5\.1/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

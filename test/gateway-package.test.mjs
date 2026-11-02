/**
 * The LiteLLM plugin's supply chain: the hash lock CI installs from, the
 * Python package's metadata, and the CI job that runs the plugin's own tests.
 * LiteLLM 1.82.7, 1.82.8 and 1.107.0 were compromised on PyPI
 * (integrations/litellm/README.md names the advisories); 1.106.2 is the
 * version the plugin is tested on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LITELLM = join(ROOT, 'integrations', 'litellm');
const read = (...p) => readFileSync(join(...p), 'utf8');

const TESTED = '1.106.2';
const COMPROMISED = ['1.82.7', '1.82.8', '1.107.0'];
const LOCK = read(LITELLM, 'requirements.lock');
const PYPROJECT = read(LITELLM, 'pyproject.toml');
const CI = read(ROOT, '.github', 'workflows', 'ci.yml');
const PKG_VERSION = JSON.parse(read(ROOT, 'package.json')).version;
const REPO = /^https:\/\/github\.com\/sakk-dev\/sakk(\/|$)/;
const LOCK_ARG = '-r integrations/litellm/requirements.lock';
const TESTS_RUN = /-m unittest integrations\/litellm\/test_sakk_gateway\.py/;

const norm = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');
const PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?==([^\s;\\]+)/;
const HASH = /^\s+--hash=sha256:[0-9a-f]{64}(\s*\\)?$/;

/** Every pin of a hash lock with its hash count; lines that are not pins are problems. */
function lockPins(text) {
  const pins = [];
  const problems = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const pin = line.match(PIN);
    if (pin) {
      cur = { name: norm(pin[1]), version: pin[2], hashes: 0 };
      pins.push(cur);
    } else if (HASH.test(line) && cur) {
      cur.hashes++;
    } else {
      problems.push(`not a pin or a sha256 hash: ${line.trim()}`);
    }
  }
  return { pins, problems };
}

function lockProblems(text) {
  const { pins, problems } = lockPins(text);
  const out = [...problems];
  if (!pins.length) out.push('the lock pins nothing');
  for (const p of pins) {
    if (!p.hashes) out.push(`${p.name}==${p.version} has no hash`);
  }
  const seen = new Set();
  for (const p of pins) {
    if (seen.has(p.name)) out.push(`${p.name} is pinned twice`);
    seen.add(p.name);
  }
  const litellm = pins.filter((p) => p.name === 'litellm');
  if (!litellm.length) out.push('the lock does not pin litellm');
  for (const p of litellm) {
    const bad = COMPROMISED.includes(p.version);
    if (bad) out.push(`litellm==${p.version} is a compromised release`);
    if (p.version !== TESTED) out.push(`litellm is pinned at ${p.version}, not ${TESTED}`);
  }
  return out;
}

/** The body of one [table] in a TOML file, up to the next table header. */
function table(toml, name) {
  const lines = toml.split('\n');
  const at = lines.findIndex((l) => l.trim() === `[${name}]`);
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && /^\[/.test(l.trim()));
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
}

/** A string or a one-line string array value of `key` in a table body. */
function value(body, key) {
  const m = (body ?? '').match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
  if (!m) return undefined;
  const v = m[1].trim();
  if (v.startsWith('[')) return [...v.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  return v.match(/^"([^"]*)"$/)?.[1];
}

/** What is wrong with the LiteLLM requirement of the package. */
function dependencyProblems(toml) {
  const deps = value(table(toml, 'project'), 'dependencies');
  if (!Array.isArray(deps)) return ['no dependencies list'];
  const lit = deps.filter((d) => /^litellm(\[|[<>=!~ ]|$)/.test(d));
  if (lit.length !== 1) return [`${lit.length} litellm requirements, not one`];
  const spec = lit[0].replace(/^litellm(\[[^\]]*\])?/, '');
  const clauses = spec.split(',').map((c) => c.trim());
  const out = [];
  if (!clauses.includes(`>=${TESTED}`)) out.push(`litellm has no lower bound >=${TESTED}`);
  // the floor is the tested version, so only compromised releases above it need excluding
  const [x, y, z] = TESTED.split('.').map(Number);
  for (const v of COMPROMISED) {
    const [a, b, c] = v.split('.').map(Number);
    const older = a < x || (a === x && (b < y || (b === y && c < z)));
    const excluded = clauses.includes(`!=${v}`);
    if (!older && !excluded) out.push(`litellm does not exclude the compromised ${v}`);
  }
  for (const c of clauses) {
    const ok = /^(>=|!=)\d+\.\d+\.\d+$/.test(c);
    if (!ok) out.push(`litellm clause ${c} is not a floor or an exclusion`);
  }
  return out;
}

/** The gateway job in ci.yml, up to the next job. */
function gatewayJob(yml) {
  const at = yml.indexOf('\n  gateway:\n');
  if (at < 0) return '';
  const rest = yml.slice(at + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function gatewayJobProblems(yml) {
  const job = gatewayJob(yml);
  if (!job) return ['ci.yml has no gateway job'];
  const out = [];
  const install = job.split('\n').filter((l) => /uv pip install/.test(l));
  if (install.length !== 1) out.push(`${install.length} uv pip install lines, not one`);
  for (const flag of ['--require-hashes', '--no-build', LOCK_ARG]) {
    if (!install.every((l) => l.includes(flag))) out.push(`the install does not use ${flag}`);
  }
  const others = job.replace(/uv pip install.*--require-hashes.*/g, '');
  const unhashed = /pip install(?!.*--require-hashes)/.test(others);
  if (unhashed) out.push('a pip install without --require-hashes');
  if (!TESTS_RUN.test(job)) out.push('the plugin tests are not run');
  if (!/^\s+runs-on: ubuntu-/m.test(job)) out.push('not on an ubuntu runner');
  const version = /^\s+version: '\d+\.\d+\.\d+'$/m.test(job);
  const checksum = /^\s+checksum: [0-9a-f]{64}$/m.test(job);
  if (!version || !checksum) out.push('uv is not pinned by version and checksum');
  if (!/^\s+UV_PYTHON_DOWNLOADS: never$/m.test(job)) out.push('uv may download its own Python');
  return out;
}

test('the committed lock pins litellm==1.106.2 with hashes and no compromised release', () => {
  assert.deepEqual(lockProblems(LOCK), []);
  // litellm[proxy] resolves to over a hundred packages
  const { pins } = lockPins(LOCK);
  assert.ok(pins.length > 100, `${pins.length} pins`);
  for (const v of COMPROMISED) {
    assert.ok(!LOCK.includes(`litellm==${v}`), `the lock names litellm==${v}`);
  }
  // the input names the same version, so a regenerated lock stays on it
  const input = read(LITELLM, 'requirements.in').split('\n');
  assert.ok(input.includes(`litellm[proxy]==${TESTED}`), `requirements.in pins ${TESTED}`);
  // made with uv's hashes and a cut-off before the 1.107.0 upload
  assert.match(LOCK, /--generate-hashes --exclude-newer 2026-10-21T11:00:00Z/);
});

test('a lock without hashes, on another LiteLLM, or on a compromised release is refused (controls)', () => {
  const block = /^litellm==1\.106\.2 \\\n(?:\s+--hash=sha256:[0-9a-f]{64}(?: \\)?\n)+/m;
  const lit = LOCK.match(block)?.[0];
  assert.ok(lit, 'the litellm block');
  const refused = (lock, re) => assert.match(lockProblems(lock).join('; '), re);
  const swap = (version) => LOCK.replace('litellm==1.106.2', `litellm==${version}`);
  refused(LOCK.replace(lit, 'litellm==1.106.2\n'), /litellm==1\.106\.2 has no hash/);
  refused(swap('1.107.0'), /litellm==1\.107\.0 is a compromised release/);
  refused(swap('1.82.8'), /litellm==1\.82\.8 is a compromised release/);
  refused(swap('1.106.3'), /pinned at 1\.106\.3, not 1\.106\.2/);
  refused(LOCK.replace(lit, ''), /does not pin litellm/);
  refused(LOCK.replace(lit, `${lit}litellm>=1.106\n`), /not a pin .*: litellm>=1\.106/);
  refused(LOCK.replace(lit, `${lit}${lit}`), /litellm is pinned twice/);
  refused('', /the lock pins nothing/);
});

test('the Python package version is the npm package version', () => {
  const project = table(PYPROJECT, 'project');
  assert.ok(project, 'pyproject.toml has a [project] table');
  assert.equal(value(project, 'version'), PKG_VERSION);
  assert.equal(value(project, 'name'), 'sakk-litellm');
  // the install line in the package's own readme names the same version
  assert.ok(read(LITELLM, 'README.pypi.md').includes(`sakk-litellm==${PKG_VERSION}`));
});

test('the package depends on LiteLLM without the compromised releases and ships only the plugin module', () => {
  assert.deepEqual(dependencyProblems(PYPROJECT), []);
  const DEP = '"litellm[proxy]>=1.106.2,!=1.107.0"';
  assert.ok(PYPROJECT.includes(DEP), 'control anchor');
  const refused = (spec, re) => {
    assert.match(dependencyProblems(PYPROJECT.replace(DEP, spec)).join('; '), re);
  };
  refused('"litellm[proxy]>=1.106.2"', /does not exclude the compromised 1\.107\.0/);
  refused('"litellm[proxy]>=1.80,!=1.107.0"', /no lower bound >=1\.106\.2/);
  refused('"litellm[proxy]"', /no lower bound/);
  refused('"litellm[proxy]>=1.106.2,!=1.107.0,<2"', /clause <2 is not a floor/);
  refused('"litellm[proxy]==1.106.2", "litellm"', /2 litellm requirements, not one/);
  const project = table(PYPROJECT, 'project');
  assert.equal(value(project, 'requires-python'), '>=3.10');
  assert.equal(value(project, 'license'), 'Apache-2.0');
  assert.deepEqual(value(project, 'license-files'), ['LICENSE', 'NOTICE']);
  assert.equal(value(project, 'readme'), 'README.pypi.md');
  const urls = [...(table(PYPROJECT, 'project.urls') ?? '').matchAll(/^(\w+) = "([^"]+)"$/gm)];
  assert.ok(urls.length >= 3, `${urls.length} project URLs`);
  for (const [, key, url] of urls) {
    assert.match(url, REPO, `${key} points outside the public repository`);
  }
  // the wheel holds sakk_gateway.py alone; the sdist adds only the readme and the licences
  const wheel = value(table(PYPROJECT, 'tool.hatch.build.targets.wheel'), 'only-include');
  assert.deepEqual(wheel, ['sakk_gateway.py']);
  const sdist = value(table(PYPROJECT, 'tool.hatch.build.targets.sdist'), 'only-include');
  assert.deepEqual(sdist, ['sakk_gateway.py', 'README.pypi.md', 'LICENSE', 'NOTICE']);
  const here = new Set(readdirSync(LITELLM));
  for (const f of sdist) assert.ok(here.has(f), `${f} is not in integrations/litellm`);
});

test("the package's LICENSE and NOTICE are the repository's own", () => {
  for (const f of ['LICENSE', 'NOTICE']) {
    assert.equal(read(LITELLM, f), read(ROOT, f), `${f} differs from the repository's`);
  }
});

test('the CI gateway job installs only from the hash lock with no source builds and runs the plugin tests', () => {
  assert.deepEqual(gatewayJobProblems(CI), []);
  const refused = (from, to, re) => {
    const changed = CI.replace(from, to);
    assert.notEqual(changed, CI, `control anchor ${from}`);
    assert.match(gatewayJobProblems(changed).join('; '), re);
  };
  refused(' --require-hashes --no-build', ' --no-build', /does not use --require-hashes/);
  refused(' --no-build -r', ' -r', /does not use --no-build/);
  refused(LOCK_ARG, 'litellm[proxy]', /does not use -r integrations/);
  const extra = `${LOCK_ARG}\n          pip install litellm`;
  refused(LOCK_ARG, extra, /a pip install without --require-hashes/);
  const install = /(\n {2}gateway:\n[\s\S]*?)(\n +uv pip install[^\n]*)/;
  refused(install, '$1$2$2', /2 uv pip install lines, not one/);
  refused('-m unittest integrations', '-m pytest integrations', /plugin tests are not run/);
  const ubuntu = /(\n {2}gateway:\n[\s\S]*?)runs-on: ubuntu-/;
  refused(ubuntu, '$1runs-on: macos-', /not on an ubuntu runner/);
  refused(/^ {6}UV_PYTHON_DOWNLOADS: never\n/m, '', /download its own Python/);
  refused(/^ {10}checksum: .*\n/m, '', /uv is not pinned/);
  refused('\n  gateway:\n', '\n  gw:\n', /no gateway job/);
});

test('every refusal code the integration draft names is raised by the plugin or by Sakk', () => {
  const draft = read(ROOT, 'docs', 'launch', 'litellm-integration-pr.md');
  const rows = [...draft.matchAll(/^- `([A-Z][A-Z_]+)` \((\d{3})\):/gm)];
  assert.ok(rows.length >= 6, `${rows.length} refusal rows in the draft`);
  const plugin = read(LITELLM, 'sakk_gateway.py');
  const mjs = readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.mjs'));
  const src = mjs.map((f) => read(ROOT, 'src', f)).join('\n');
  for (const [, code, status] of rows) {
    if (code.startsWith('SAKK_')) {
      const raised = plugin.includes(`_refuse(${status}, "${code}"`);
      assert.ok(raised, `the plugin does not refuse ${status} ${code}`);
    } else {
      const raised = src.includes(`'${code}'`) || src.includes(`"${code}"`);
      assert.ok(raised, `Sakk does not raise ${code}`);
    }
  }
});

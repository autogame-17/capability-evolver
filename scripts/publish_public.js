const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

function run(cmd, opts = {}) {
  const { dryRun = false } = opts;
  if (dryRun) {
    process.stdout.write(`[dry-run] ${cmd}\n`);
    return '';
  }
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function hasCommand(cmd) {
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('where', [cmd], { stdio: 'ignore' });
      return res.status === 0;
    }
    const res = spawnSync('which', [cmd], { stdio: 'ignore' });
    return res.status === 0;
  } catch (e) {
    return false;
  }
}

function resolveGhExecutable() {
  if (hasCommand('gh')) return 'gh';
  const candidates = [
    'C:\\Program Files\\GitHub CLI\\gh.exe',
    'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {
      // ignore
    }
  }
  return null;
}

function resolveClawhubExecutable() {
  // On Windows, Node spawn/spawnSync does not always resolve PATHEXT the same way as shells.
  // Prefer the explicit .cmd shim when available to avoid false "not logged in" detection.
  if (process.platform === 'win32') {
    if (hasCommand('clawhub.cmd')) return 'clawhub.cmd';
    if (hasCommand('clawhub')) return 'clawhub';
  } else {
    if (hasCommand('clawhub')) return 'clawhub';
  }
  // Common npm global bin location on Windows.
  const candidates = [
    'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\clawhub.cmd',
    'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\clawhub.exe',
    'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\clawhub.ps1',
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {
      // ignore
    }
  }
  return null;
}

function canUseClawhub() {
  const exe = resolveClawhubExecutable();
  if (!exe) return { ok: false, reason: 'clawhub CLI not found (install: npm i -g clawhub)' };
  return { ok: true, exe };
}

function isClawhubLoggedIn() {
  const exe = resolveClawhubExecutable();
  if (!exe) return false;
  try {
    const res = spawnClawhub(exe, ['whoami'], { stdio: 'ignore' });
    return res.status === 0;
  } catch (e) {
    return false;
  }
}

function spawnClawhub(exe, args, options) {
  // On Windows, directly spawning a .cmd can be flaky; using cmd.exe preserves argument parsing.
  // (Using shell:true can break clap/commander style option parsing for some CLIs.)
  const opts = options || {};
  if (process.platform === 'win32' && typeof exe === 'string') {
    const lower = exe.toLowerCase();
    if (lower.endsWith('.cmd')) {
      return spawnSync('cmd.exe', ['/d', '/s', '/c', exe, ...(args || [])], opts);
    }
  }
  return spawnSync(exe, args || [], opts);
}

function publishToClawhub({ skillDir, slug, name, version, changelog, tags, dryRun }) {
  const ok = canUseClawhub();
  if (!ok.ok) throw new Error(ok.reason);

  // Idempotency: if this version already exists on ClawHub, skip publishing.
  try {
    const inspect = spawnClawhub(ok.exe, ['inspect', slug, '--version', version], { stdio: 'ignore' });
    if (inspect.status === 0) {
      process.stdout.write(`ClawHub already has ${slug}@${version}. Skipping.\n`);
      return;
    }
  } catch (e) {
    // ignore inspect failures; publish will surface errors if needed
  }

  if (!dryRun && !isClawhubLoggedIn()) {
    throw new Error('Not logged in to ClawHub. Run: clawhub login');
  }

  const args = ['publish', skillDir, '--slug', slug, '--name', name, '--version', version];
  if (changelog) args.push('--changelog', changelog);
  if (tags) args.push('--tags', tags);

  if (dryRun) {
    process.stdout.write(`[dry-run] ${ok.exe} ${args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n`);
    return;
  }

  // Capture output to handle "version already exists" idempotently.
  const res = spawnClawhub(ok.exe, args, { encoding: 'utf8' });
  const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim();

  if (res.status === 0) {
    if (out) process.stdout.write(out + '\n');
    return;
  }

  // Some clawhub deployments do not support reliable "inspect" by slug.
  // Treat "Version already exists" as success to make publishing idempotent.
  if (/version already exists/i.test(out)) {
    process.stdout.write(`ClawHub already has ${slug}@${version}. Skipping.\n`);
    return;
  }

  if (out) process.stderr.write(out + '\n');
  throw new Error(`clawhub publish failed for slug ${slug}`);
}

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

function ensureClean(dryRun) {
  const status = run('git status --porcelain', { dryRun });
  if (!dryRun && status) {
    throw new Error('Working tree is not clean. Commit or stash before publishing.');
  }
}

function ensureBranch(expected, dryRun) {
  const current = run('git rev-parse --abbrev-ref HEAD', { dryRun }) || expected;
  if (!dryRun && current !== expected) {
    throw new Error(`Current branch is ${current}. Expected ${expected}.`);
  }
}

function ensureRemote(remote, dryRun) {
  try {
    run(`git remote get-url ${remote}`, { dryRun });
  } catch (e) {
    throw new Error(`Remote "${remote}" not found. Add it manually before running this script.`);
  }
}

function ensureTagAvailable(tag, dryRun) {
  if (!tag) return;
  const exists = run(`git tag --list ${tag}`, { dryRun });
  if (!dryRun && exists) {
    throw new Error(`Tag ${tag} already exists.`);
  }
}

function ensureDir(dir, dryRun) {
  if (dryRun) return;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function rmDir(dir, dryRun) {
  if (dryRun) return;
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(src, dest, dryRun) {
  if (dryRun) return;
  if (!fs.existsSync(src)) throw new Error(`Missing build output dir: ${src}`);
  ensureDir(dest, dryRun);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d, dryRun);
    else if (ent.isFile()) {
      ensureDir(path.dirname(d), dryRun);
      fs.copyFileSync(s, d);
    }
  }
}

function createReleaseWithGh({ repo, tag, title, notes, notesFile, dryRun }) {
  if (!repo || !tag) return;
  const ghExe = resolveGhExecutable();
  if (!ghExe) {
    throw new Error('gh CLI not found. Install GitHub CLI or provide a GitHub token for API-based release creation.');
  }
  const args = ['release', 'create', tag, '--repo', repo];
  if (title) args.push('-t', title);
  if (notesFile) args.push('-F', notesFile);
  else if (notes) args.push('-n', notes);
  else args.push('-n', 'Release created by publish script.');

  if (dryRun) {
    process.stdout.write(`[dry-run] ${ghExe} ${args.join(' ')}\n`);
    return;
  }

  const res = spawnSync(ghExe, args, { stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error('gh release create failed');
  }
}

function canUseGhForRelease() {
  const ghExe = resolveGhExecutable();
  if (!ghExe) return { ok: false, reason: 'gh CLI not found' };
  try {
    // Non-interactive check: returns 0 when authenticated.
    const res = spawnSync(ghExe, ['auth', 'status', '-h', 'github.com'], { stdio: 'ignore' });
    if (res.status === 0) return { ok: true };
    return { ok: false, reason: 'gh not authenticated (run: gh auth login)' };
  } catch (e) {
    return { ok: false, reason: 'failed to check gh auth status' };
  }
}

function getGithubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT || '';
}

function readReleaseNotes(notes, notesFile) {
  if (notesFile) {
    try {
      return fs.readFileSync(notesFile, 'utf8');
    } catch (e) {
      throw new Error(`Failed to read RELEASE_NOTES_FILE: ${notesFile}`);
    }
  }
  if (notes) return String(notes);
  return '';
}

function githubRequestJson({ method, repo, apiPath, token, body, dryRun }) {
  if (dryRun) {
    process.stdout.write(`[dry-run] GitHub API ${method} ${repo} ${apiPath}\n`);
    return Promise.resolve({ status: 200, json: null });
  }

  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const opts = {
    method,
    hostname: 'api.github.com',
    path: `/repos/${repo}${apiPath}`,
    headers: {
      'User-Agent': 'evolver-publish-script',
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `token ${token}` } : {}),
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (raw += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch (e) {
          json = null;
        }
        resolve({ status: res.statusCode || 0, json, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ensureReleaseWithApi({ repo, tag, title, notes, notesFile, dryRun }) {
  if (!repo || !tag) return;

  const token = getGithubToken();
  if (!dryRun) {
    requireEnv('GITHUB_TOKEN (or GH_TOKEN/GITHUB_PAT)', token);
  }

  // If release already exists, skip.
  const existing = await githubRequestJson({
    method: 'GET',
    repo,
    apiPath: `/releases/tags/${encodeURIComponent(tag)}`,
    token,
    dryRun,
  });

  if (!dryRun && existing.status === 200) {
    process.stdout.write(`Release already exists for tag ${tag}. Skipping.\n`);
    return;
  }

  const bodyText = readReleaseNotes(notes, notesFile) || 'Release created by publish script.';
  const payload = {
    tag_name: tag,
    name: title || tag,
    body: bodyText,
    draft: false,
    prerelease: false,
  };

  const created = await githubRequestJson({
    method: 'POST',
    repo,
    apiPath: '/releases',
    token,
    body: payload,
    dryRun,
  });

  if (!dryRun && (created.status < 200 || created.status >= 300)) {
    const msg = (created.json && created.json.message) || created.raw || 'Unknown error';
    throw new Error(`Failed to create GitHub Release (${created.status}): ${msg}`);
  }

  process.stdout.write(`Created GitHub Release for tag ${tag}\n`);
}

// Collect unique external contributors from private repo commits since the last release.
// Returns an array of "Name <email>" strings suitable for Co-authored-by trailers.
// GitHub counts Co-authored-by toward the Contributors graph.
function getContributorsSinceLastRelease() {
  const EXCLUDED = new Set([
    'evolver-publish@local',
    'evolver@local',
    'openclaw@users.noreply.github.com',
  ]);

  try {
    let baseCommit = '';
    try {
      baseCommit = execSync(
        'git log -n 1 --pretty=%H --grep="chore(release): prepare v"',
        { encoding: 'utf8', cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
    } catch (_) {}

    const range = baseCommit ? `${baseCommit}..HEAD` : '-30';
    const raw = execSync(
      `git log ${range} --pretty="%aN <%aE>"`,
      { encoding: 'utf8', cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();

    if (!raw) return [];

    const seen = new Set();
    const contributors = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const emailMatch = trimmed.match(/<([^>]+)>/);
      const email = emailMatch ? emailMatch[1].toLowerCase() : '';
      if (EXCLUDED.has(email)) continue;
      if (seen.has(email)) continue;
      seen.add(email);
      contributors.push(trimmed);
    }
    return contributors;
  } catch (_) {
    return [];
  }
}

function main() {
  const dryRun = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

  const sourceBranch = process.env.SOURCE_BRANCH || 'main';
  const publicRemote = process.env.PUBLIC_REMOTE || 'public';
  const publicBranch = process.env.PUBLIC_BRANCH || 'main';
  const publicRepo = process.env.PUBLIC_REPO || '';
  const outDir = process.env.PUBLIC_OUT_DIR || 'dist-public';
  const useBuildOutput = String(process.env.PUBLIC_USE_BUILD_OUTPUT || 'true').toLowerCase() === 'true';
  const releaseOnly = String(process.env.PUBLIC_RELEASE_ONLY || '').toLowerCase() === 'true';

  const clawhubSkip = String(process.env.CLAWHUB_SKIP || '').toLowerCase() === 'true';
  const clawhubPublish = String(process.env.CLAWHUB_PUBLISH || '').toLowerCase() === 'false' ? false : !clawhubSkip;
  // Workaround for registry redirect/auth issues: default to the www endpoint.
  const clawhubRegistry = process.env.CLAWHUB_REGISTRY || 'https://www.clawhub.ai';

  // If publishing build output, require a repo URL or GH repo slug for cloning.
  if (useBuildOutput) {
    requireEnv('PUBLIC_REPO', publicRepo);
  }

  let releaseTag = process.env.RELEASE_TAG || '';
  let releaseTitle = process.env.RELEASE_TITLE || '';
  const releaseNotes = process.env.RELEASE_NOTES || '';
  const releaseNotesFile = process.env.RELEASE_NOTES_FILE || '';
  const releaseSkip = String(process.env.RELEASE_SKIP || '').toLowerCase() === 'true';
  // Default behavior: create release unless explicitly skipped.
  // Backward compatibility: RELEASE_CREATE=true forces creation.
  // Note: RELEASE_CREATE=false is ignored; use RELEASE_SKIP=true instead.
  const releaseCreate = String(process.env.RELEASE_CREATE || '').toLowerCase() === 'true' ? true : !releaseSkip;
  const releaseUseGh = String(process.env.RELEASE_USE_GH || '').toLowerCase() === 'true';

  // If not provided, infer from build output package.json version.
  if (!releaseTag && useBuildOutput) {
    try {
      const builtPkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), outDir, 'package.json'), 'utf8'));
      if (builtPkg && builtPkg.version) releaseTag = `v${builtPkg.version}`;
      if (!releaseTitle && releaseTag) releaseTitle = releaseTag;
    } catch (e) {}
  }

  const releaseVersion = String(releaseTag || '').startsWith('v') ? String(releaseTag).slice(1) : '';

  // Fail fast on missing release prerequisites to avoid half-publishing.
  // Strategy:
  // - If RELEASE_USE_GH=true: require gh + auth
  // - Else: prefer gh+auth; fallback to API token; else fail
  let releaseMode = 'none';
  if (releaseCreate && releaseTag) {
    if (releaseUseGh) {
      const ghOk = canUseGhForRelease();
      if (!dryRun && !ghOk.ok) {
        throw new Error(`Cannot create release via gh: ${ghOk.reason}`);
      }
      releaseMode = 'gh';
    } else {
      const ghOk = canUseGhForRelease();
      if (ghOk.ok) {
        releaseMode = 'gh';
      } else {
        const token = getGithubToken();
        if (!dryRun && !token) {
          throw new Error(
            'Cannot create GitHub Release: neither gh (installed+authenticated) nor GITHUB_TOKEN (or GH_TOKEN/GITHUB_PAT) is available.'
          );
        }
        releaseMode = 'api';
      }
    }
  }

  // In release-only mode we do not push code or tags, only create a GitHub Release for an existing tag.
  if (!releaseOnly) {
    ensureClean(dryRun);
    ensureBranch(sourceBranch, dryRun);
    ensureTagAvailable(releaseTag, dryRun);
  } else {
    requireEnv('RELEASE_TAG', releaseTag);
  }

  if (!releaseOnly) {
    if (!useBuildOutput) {
      ensureRemote(publicRemote, dryRun);
      run(`git push ${publicRemote} ${sourceBranch}:${publicBranch}`, { dryRun });
    } else {
      const tmpBase = path.join(os.tmpdir(), 'evolver-public-publish');
      const tmpRepoDir = path.join(tmpBase, `repo_${Date.now()}`);
      const buildAbs = path.resolve(process.cwd(), outDir);

      rmDir(tmpRepoDir, dryRun);
      ensureDir(tmpRepoDir, dryRun);

      run(`git clone --depth 1 https://github.com/${publicRepo}.git "${tmpRepoDir}"`, { dryRun });
      run(`git -C "${tmpRepoDir}" checkout -B ${publicBranch}`, { dryRun });

      // Replace repo contents with build output (except .git)
      if (!dryRun) {
        const entries = fs.readdirSync(tmpRepoDir, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.name === '.git') continue;
          fs.rmSync(path.join(tmpRepoDir, ent.name), { recursive: true, force: true });
        }
      }
      copyDir(buildAbs, tmpRepoDir, dryRun);

      run(`git -C "${tmpRepoDir}" add -A`, { dryRun });
      const msg = releaseTag ? `Release ${releaseTag}` : `Publish build output`;

      // If build output is identical to current public branch, skip commit/push.
      const pending = run(`git -C "${tmpRepoDir}" status --porcelain`, { dryRun });
      if (!dryRun && !pending) {
        process.stdout.write('Public repo already matches build output. Skipping commit/push.\n');
      } else {
        const contributors = getContributorsSinceLastRelease();
        let commitMsg = msg.replace(/"/g, '\\"');
        if (contributors.length > 0) {
          const trailers = contributors.map(c => `Co-authored-by: ${c}`).join('\n');
          commitMsg += `\n\n${trailers.replace(/"/g, '\\"')}`;
          process.stdout.write(`Including ${contributors.length} contributor(s) in publish commit.\n`);
        }
        run(
          `git -C "${tmpRepoDir}" -c user.name="evolver-publish" -c user.email="evolver-publish@local" commit -m "${commitMsg}"`,
          { dryRun }
        );
        run(`git -C "${tmpRepoDir}" push origin ${publicBranch}`, { dryRun });
      }

      if (releaseTag) {
        const tagMsg = releaseTitle || `Release ${releaseTag}`;
        // If tag already exists in the public repo, do not recreate it.
        try {
          run(`git -C "${tmpRepoDir}" fetch --tags`, { dryRun });
          const exists = run(`git -C "${tmpRepoDir}" tag --list ${releaseTag}`, { dryRun });
          if (!dryRun && exists) {
            process.stdout.write(`Tag ${releaseTag} already exists in public repo. Skipping tag creation.\n`);
          } else {
            run(`git -C "${tmpRepoDir}" tag -a ${releaseTag} -m "${tagMsg.replace(/"/g, '\\"')}"`, { dryRun });
            run(`git -C "${tmpRepoDir}" push origin ${releaseTag}`, { dryRun });
          }
        } catch (e) {
          // If tag operations fail, rethrow to avoid publishing a release without a tag.
          throw e;
        }
      }
    }

    if (releaseTag) {
      if (!useBuildOutput) {
        const msg = releaseTitle || `Release ${releaseTag}`;
        run(`git tag -a ${releaseTag} -m "${msg.replace(/"/g, '\\"')}"`, { dryRun });
        run(`git push ${publicRemote} ${releaseTag}`, { dryRun });
      }
    }
  }

  if (releaseCreate) {
    if (releaseMode === 'gh') {
      createReleaseWithGh({
        repo: publicRepo,
        tag: releaseTag,
        title: releaseTitle,
        notes: releaseNotes,
        notesFile: releaseNotesFile,
        dryRun,
      });
    } else if (releaseMode === 'api') {
      return ensureReleaseWithApi({
        repo: publicRepo,
        tag: releaseTag,
        title: releaseTitle,
        notes: releaseNotes,
        notesFile: releaseNotesFile,
        dryRun,
      });
    }
  }

  // Publish to ClawHub after GitHub release succeeds (default enabled).
  if (clawhubPublish && releaseVersion) {
    process.env.CLAWHUB_REGISTRY = clawhubRegistry;

    const skillDir = useBuildOutput ? path.resolve(process.cwd(), outDir) : process.cwd();
    const changelog = releaseTitle ? `GitHub Release ${releaseTitle}` : `GitHub Release ${releaseTag}`;

    publishToClawhub({
      skillDir,
      slug: 'evolver',
      name: 'Evolver',
      version: releaseVersion,
      changelog,
      tags: 'latest',
      dryRun,
    });

    publishToClawhub({
      skillDir,
      slug: 'capability-evolver',
      name: 'Evolver',
      version: releaseVersion,
      changelog,
      tags: 'latest',
      dryRun,
    });
  }
}

try {
  const maybePromise = main();
  if (maybePromise && typeof maybePromise.then === 'function') {
    maybePromise.catch(e => {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    });
  }
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}


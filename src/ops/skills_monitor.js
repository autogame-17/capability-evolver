// Skills Monitor (v2.0) - Evolver Core Module
// Checks installed skills for real issues, auto-heals simple problems.
// Zero Feishu dependency.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getSkillsDir, getWorkspaceRoot } = require('../gep/paths');

const IGNORE_LIST = new Set([
    'common',
    'clawhub',
    'input-validator',
    'proactive-agent',
    'security-audit',
]);

// Load user-defined ignore list
try {
    var ignoreFile = path.join(getWorkspaceRoot(), '.skill_monitor_ignore');
    if (fs.existsSync(ignoreFile)) {
        fs.readFileSync(ignoreFile, 'utf8').split('\n').forEach(function(l) {
            var t = l.trim();
            if (t && !t.startsWith('#')) IGNORE_LIST.add(t);
        });
    }
} catch (e) { /* ignore */ }

function checkSkill(skillName) {
    var SKILLS_DIR = getSkillsDir();
    if (IGNORE_LIST.has(skillName)) return null;
    var skillPath = path.join(SKILLS_DIR, skillName);
    var issues = [];

    try { if (!fs.statSync(skillPath).isDirectory()) return null; } catch (e) { return null; }

    var mainFile = 'index.js';
    var pkgPath = path.join(skillPath, 'package.json');
    var hasPkg = false;

    if (fs.existsSync(pkgPath)) {
        hasPkg = true;
        try {
            var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.main) mainFile = pkg.main;
            if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
                if (!fs.existsSync(path.join(skillPath, 'node_modules'))) {
                    var entryAbs = path.join(skillPath, mainFile);
                    if (fs.existsSync(entryAbs) && mainFile.endsWith('.js')) {
                        try {
                            execSync('node -e "require(\'' + entryAbs.replace(/'/g, "\\'") + '\')"', {
                                stdio: 'ignore', timeout: 5000, cwd: skillPath
                            });
                        } catch (e) {
                            issues.push('Missing node_modules (needs npm install)');
                        }
                    }
                }
            }
        } catch (e) {
            issues.push('Invalid package.json');
        }
    }

    if (mainFile.endsWith('.js')) {
        var entryPoint = path.join(skillPath, mainFile);
        if (fs.existsSync(entryPoint)) {
            try {
                execSync('node -c "' + entryPoint + '"', { stdio: 'ignore', timeout: 5000 });
            } catch (e) {
                issues.push('Syntax Error in ' + mainFile);
            }
        }
    }

    if (hasPkg && !fs.existsSync(path.join(skillPath, 'SKILL.md'))) {
        issues.push('Missing SKILL.md');
    }

    return issues.length > 0 ? { name: skillName, issues: issues } : null;
}

function autoHeal(skillName, issues) {
    var SKILLS_DIR = getSkillsDir();
    var skillPath = path.join(SKILLS_DIR, skillName);
    var healed = [];

    for (var i = 0; i < issues.length; i++) {
        if (issues[i] === 'Missing node_modules (needs npm install)') {
            try {
                execSync('npm install --production --no-audit --no-fund', {
                    cwd: skillPath, stdio: 'ignore', timeout: 30000
                });
                healed.push(issues[i]);
                console.log('[SkillsMonitor] Auto-healed ' + skillName + ': npm install');
            } catch (e) {}
        } else if (issues[i] === 'Missing SKILL.md') {
            try {
                var name = skillName.replace(/-/g, ' ');
                fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# ' + skillName + '\n\n' + name + ' skill.\n');
                healed.push(issues[i]);
                console.log('[SkillsMonitor] Auto-healed ' + skillName + ': created SKILL.md stub');
            } catch (e) {}
        }
    }
    return healed;
}

function run(options) {
    var heal = (options && options.autoHeal) !== false;
    var SKILLS_DIR = getSkillsDir();
    var skills = fs.readdirSync(SKILLS_DIR);
    var report = [];

    for (var i = 0; i < skills.length; i++) {
        if (skills[i].startsWith('.')) continue;
        var result = checkSkill(skills[i]);
        if (result) {
            if (heal) {
                var healed = autoHeal(result.name, result.issues);
                result.issues = result.issues.filter(function(issue) { return !healed.includes(issue); });
                if (result.issues.length === 0) continue;
            }
            report.push(result);
        }
    }
    return report;
}

if (require.main === module) {
    var issues = run();
    console.log(JSON.stringify(issues, null, 2));
    process.exit(issues.length > 0 ? 1 : 0);
}

module.exports = { run, checkSkill, autoHeal };

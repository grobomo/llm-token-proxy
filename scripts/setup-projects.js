#!/usr/bin/env node
'use strict';

/**
 * setup-projects.js
 * Auto-discovers projects and configures per-project attribution headers
 * for the LLM token-tracking proxy.
 *
 * Usage:
 *   node setup-projects.js                    # configure all discovered projects
 *   node setup-projects.js --dry-run          # preview changes without writing
 *   node setup-projects.js --force            # re-configure even if already set
 *   node setup-projects.js --restore          # undo: restore all .bak files
 *   node setup-projects.js --roots ~/a,~/b    # custom project roots
 */

const fs   = require('fs');
const path = require('path');

const HOME = process.env.HOME || '/home/ubu';
const DEFAULT_ROOTS = [
  path.join(HOME, 'Documents/ProjectsCL1'),
  path.join(HOME, '.openclaw/workspace'),
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.claude', '.github', 'archive', '.archive',
  'dist', 'build', 'coverage', '__pycache__', '.venv',
]);

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, force: false, restore: false, roots: DEFAULT_ROOTS };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--force') opts.force = true;
    else if (args[i] === '--restore') opts.restore = true;
    else if (args[i] === '--roots' && args[i+1]) {
      opts.roots = args[++i].split(',').map(r => r.replace(/^~/, HOME));
    }
  }
  return opts;
}

function isProjectDir(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const names = new Set(entries.map(e => e.name));
  return names.has('.git') || names.has('package.json') || names.has('Cargo.toml') ||
         names.has('go.mod') || names.has('pyproject.toml') || names.has('Makefile') ||
         names.has('CLAUDE.md');
}

function discoverProjects(roots) {
  const projects = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;

    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.openclaw') continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const dirPath = path.join(root, entry.name);

      // Check if this IS a project
      if (isProjectDir(dirPath)) {
        projects.push(dirPath);
        continue;
      }

      // Otherwise check one level deeper (for group dirs like _grobomo/)
      try {
        const subEntries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const sub of subEntries) {
          if (!sub.isDirectory()) continue;
          if (sub.name.startsWith('.') || SKIP_DIRS.has(sub.name)) continue;
          const subPath = path.join(dirPath, sub.name);
          if (isProjectDir(subPath)) {
            projects.push(subPath);
          }
        }
      } catch { /* permission errors, etc */ }
    }
  }

  return projects;
}

function deriveProjectName(projectPath) {
  const publishJson = path.join(projectPath, '.github', 'publish.json');
  if (fs.existsSync(publishJson)) {
    try {
      const pub = JSON.parse(fs.readFileSync(publishJson, 'utf-8'));
      if (pub.project_name) return pub.project_name;
    } catch { /* fall through */ }
  }
  return path.basename(projectPath);
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return null;
  }
}

function backupFile(filePath) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bakPath = filePath + '.bak.' + ts;
  fs.copyFileSync(filePath, bakPath);
  return bakPath;
}

function configureProject(projectPath, projectName, opts) {
  const claudeDir = path.join(projectPath, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const headerValue = `X-Project: ${projectName}`;

  const existing = readSettings(settingsPath);

  // Check if already configured
  if (existing && existing.env && existing.env.ANTHROPIC_CUSTOM_HEADERS) {
    const current = existing.env.ANTHROPIC_CUSTOM_HEADERS;
    if (current.includes('X-Project:') && !opts.force) {
      return { action: 'skipped', reason: 'already configured', current };
    }
  }

  if (opts.dryRun) {
    return { action: 'would_configure', header: headerValue, exists: !!existing };
  }

  // Backup existing file
  let bakPath = null;
  if (existing && fs.existsSync(settingsPath)) {
    bakPath = backupFile(settingsPath);
  }

  // Merge or create
  const settings = existing || {};
  if (!settings.env) settings.env = {};

  // Preserve existing custom headers, append X-Project if other headers exist
  const existingHeaders = settings.env.ANTHROPIC_CUSTOM_HEADERS || '';
  if (existingHeaders && !existingHeaders.includes('X-Project:')) {
    settings.env.ANTHROPIC_CUSTOM_HEADERS = existingHeaders + '\n' + headerValue;
  } else {
    settings.env.ANTHROPIC_CUSTOM_HEADERS = headerValue;
  }

  // Ensure .claude directory exists
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { action: existing ? 'updated' : 'created', backup: bakPath, header: headerValue };
}

function restoreBackups(roots) {
  const projects = discoverProjects(roots);
  let restored = 0;

  for (const projectPath of projects) {
    const claudeDir = path.join(projectPath, '.claude');
    if (!fs.existsSync(claudeDir)) continue;

    const files = fs.readdirSync(claudeDir).filter(f => f.startsWith('settings.json.bak.'));
    if (files.length === 0) continue;

    // Restore most recent backup
    files.sort();
    const latest = files[files.length - 1];
    const bakPath = path.join(claudeDir, latest);
    const settingsPath = path.join(claudeDir, 'settings.json');

    fs.copyFileSync(bakPath, settingsPath);
    fs.unlinkSync(bakPath);
    console.log(`  restored: ${projectPath} (from ${latest})`);
    restored++;
  }

  console.log(`\nRestored ${restored} project(s).`);
}

function main() {
  const opts = parseArgs();

  if (opts.restore) {
    console.log('=== Restoring backups ===\n');
    restoreBackups(opts.roots);
    return;
  }

  console.log(`=== LLM Token Proxy — Project Setup${opts.dryRun ? ' (DRY RUN)' : ''} ===\n`);
  console.log(`Scanning: ${opts.roots.join(', ')}\n`);

  const projects = discoverProjects(opts.roots);

  if (projects.length === 0) {
    console.log('No projects found.');
    return;
  }

  const results = { created: 0, updated: 0, skipped: 0 };

  for (const projectPath of projects.sort()) {
    const name = deriveProjectName(projectPath);
    const result = configureProject(projectPath, name, opts);

    const shortPath = projectPath.replace(HOME, '~');
    if (result.action === 'skipped') {
      console.log(`  skip: ${shortPath} (${result.reason})`);
      results.skipped++;
    } else if (result.action === 'would_configure') {
      console.log(`  [dry] ${shortPath} → ${result.header}${result.exists ? ' (merge)' : ' (new)'}`);
    } else {
      const bakNote = result.backup ? ` (backup: ${path.basename(result.backup)})` : '';
      console.log(`  ${result.action}: ${shortPath} → ${result.header}${bakNote}`);
      results[result.action]++;
    }
  }

  console.log(`\nDone. ${results.created} created, ${results.updated} updated, ${results.skipped} skipped.`);
  if (opts.dryRun) console.log('(No files were modified — re-run without --dry-run to apply)');
}

main();

// @ts-nocheck
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

async function readJsonFile(filePath, fallback) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(stripJsonComments(text));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.vuenexus.bak`;
    if (!fs.existsSync(backupPath)) await fsp.copyFile(filePath, backupPath);
  }
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function opencodeConfigPath(scope = 'global', cwd = process.cwd(), home = os.homedir()) {
  if (scope === 'project') return path.join(path.resolve(cwd), 'opencode.json');
  return path.join(home, '.config', 'opencode', 'opencode.json');
}

function opencodeSkillDir(home = os.homedir()) {
  return path.join(home, '.config', 'opencode', 'skill', 'vuenexus');
}

function packagedSkillPath() {
  return path.join(packageRoot, 'skills', 'vuenexus', 'SKILL.md');
}

function mcpCommand(opts = {}) {
  const command = opts.command ?? 'vuenexus';
  const db = opts.db ?? '.vuenexus/lbug';
  return [command, 'mcp', '--db', db];
}

export function opencodeSetupPaths(opts = {}) {
  const scope = opts.scope ?? 'global';
  const home = opts.home ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  return {
    configPath: path.resolve(opts.config ?? opencodeConfigPath(scope, cwd, home)),
    skillDir: path.resolve(opts.skillDir ?? opencodeSkillDir(home)),
    skillPath: path.resolve(opts.skillDir ?? opencodeSkillDir(home), 'SKILL.md'),
  };
}

export async function setupOpencode(opts = {}) {
  const paths = opencodeSetupPaths(opts);
  const config = await readJsonFile(paths.configPath, {});
  config.mcp ??= {};
  config.mcp.vuenexus = {
    type: 'local',
    command: mcpCommand(opts),
    enabled: true,
  };

  await writeJsonFile(paths.configPath, config);

  await fsp.mkdir(paths.skillDir, { recursive: true });
  const skillSource = opts.skillSource ?? packagedSkillPath();
  await fsp.copyFile(skillSource, paths.skillPath);

  return {
    agent: 'opencode',
    scope: opts.scope ?? 'global',
    configPath: paths.configPath,
    skillPath: paths.skillPath,
    mcp: config.mcp.vuenexus,
  };
}


import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setupOpencode } from '../dist/setup.js';

test('sets up opencode MCP and skill files without overwriting unrelated config', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vuenexus-opencode-'));
  const configPath = path.join(home, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      theme: 'system',
      mcp: {
        existing: { type: 'local', command: ['echo', 'ok'], enabled: true },
      },
    }),
  );

  const result = await setupOpencode({
    home,
    db: '.vuenexus/lbug',
    command: 'vuenexus',
  });

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.theme, 'system');
  assert.deepEqual(config.mcp.existing.command, ['echo', 'ok']);
  assert.deepEqual(config.mcp.vuenexus, {
    type: 'local',
    command: ['vuenexus', 'mcp', '--db', '.vuenexus/lbug'],
    enabled: true,
  });
  assert.ok(fs.existsSync(path.join(home, '.config', 'opencode', 'skill', 'vuenexus', 'SKILL.md')));
  assert.equal(result.configPath, configPath);
});


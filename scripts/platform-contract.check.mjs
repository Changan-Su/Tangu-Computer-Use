// Offline platform contract: register definitions only, never run native input or install helpers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
if (!process.env.CU_CONTRACT_PLATFORM) {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, CU_CONTRACT_PLATFORM: platform }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
    process.stdout.write(r.stdout);
  }
} else {
  const platform = process.env.CU_CONTRACT_PLATFORM;
  Object.defineProperty(process, 'platform', { value: platform });
  let meta;
  const plugin = (await import('../tangu-plugins/computer-use/dist/index.js')).default;
  plugin.activate({ registerPlugin: (m) => { meta = m; }, registerCommand() {}, log() {}, sdk: { pluginStore: { isPluginEnabledSync: () => true } } });
  const visible = meta.toolProvider.tools().filter((t) => t.isEnabledFor({ capabilities: { hostExec: true } }));
  for (const name of ['find_roots', 'observe_ui', 'search_ui', 'expand_ui', 'inspect_ui', 'act_ui']) assert(visible.some((t) => t.name === name), `${platform}: missing ${name}`);
  assert.equal(visible.some((t) => t.name === 'ensure_app'), platform === 'darwin');
  const prompt = meta.promptSection({ execMode: 'host' });
  assert.match(prompt, /already available|directly callable/i);
  if (platform !== 'darwin') assert.doesNotMatch(prompt, /call ensure_app first/);
  const skill = readFileSync(new URL('../skills/computer-use/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /macOS only/);
  assert.match(skill, /Windows.*Linux/);
  console.log(`${platform}: Computer Use tool and prompt contract passed`);
}

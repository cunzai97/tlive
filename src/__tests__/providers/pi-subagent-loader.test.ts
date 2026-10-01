import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { createSubagentResourceLoader } from '../../client/providers/pi-subagent-extension.js';
import { loadPiProviderConfig } from '../../client/providers/pi-config.js';

let root: string;
let cwd: string;
let agentDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tlive-subagent-loader-'));
  cwd = join(root, 'work'); agentDir = join(root, 'agent');
  mkdirSync(cwd); mkdirSync(agentDir);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

const definition = (name: string) => `pi.registerTool({ name: '${name}', label: '${name}', description: 'fixture', parameters: {type:'object',properties:{}}, execute: async () => ({content: [{type:'text',text:'fixture'}]}) });`;
function originalExtension() {
  const dir = join(agentDir, 'extensions'); mkdirSync(dir);
  writeFileSync(join(dir, 'original.ts'), `export default function(pi) { ${definition('subagent')} ${definition('keep_me')} pi.on('agent_start', async () => {}); pi.registerCommand('keep_command', { description: 'fixture', handler: async () => {} }); }`);
}

describe('isolated opt-in Pi subagent flow extension', () => {
  it('is disabled by default and preserves the configured filename exactly', () => {
    const get = (key: string, fallback = '') => key === 'TL_PI_SUBAGENT_EXTENSION_FILE' ? '/tmp/a.ts' : fallback;
    expect(loadPiProviderConfig({ get }).subagentExtensionFile).toBe('/tmp/a.ts');
    expect(loadPiProviderConfig({ get: (_key, fallback = '') => fallback }).subagentExtensionFile).toBeUndefined();
  });
  it('refuses missing or non-subagent replacement without silently dropping the original tool', async () => {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    await expect(createSubagentResourceLoader({ cwd, agentDir, settingsManager, file: join(root, 'missing.ts') })).rejects.toThrow('does not exist');
    const file = join(root, 'invalid.ts'); writeFileSync(file, 'export default function() {}');
    await expect(createSubagentResourceLoader({ cwd, agentDir, settingsManager, file })).rejects.toThrow('did not register subagent');
  });
  it('loads the actual staged extension with SDK and replaces only the old subagent registration', async () => {
    originalExtension();
    const file = resolve('integrations/pi-subagent/index.ts');
    const loader = await createSubagentResourceLoader({ cwd, agentDir, file, settingsManager: SettingsManager.create(cwd, agentDir) });
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    const subagents = loaded.extensions.filter(extension => extension.tools.has('subagent'));
    expect(subagents).toHaveLength(1);
    expect(resolve(subagents[0].resolvedPath)).toBe(file);
    const original = loaded.extensions.find(extension => extension.tools.has('keep_me'))!;
    expect(original.tools.has('subagent')).toBe(false);
    expect(original.commands.has('keep_command')).toBe(true);
    expect(original.handlers.has('agent_start')).toBe(true);
    expect(subagents[0].tools.get('subagent')!.definition.execute).toBeTypeOf('function');
  });
});

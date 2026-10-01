import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DefaultResourceLoader, type SettingsManager, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import { expandTilde } from '../../shared/core/path.js';

/** Isolated opt-in replacement: do not overwrite ~/.pi or disable unrelated extensions. */
export async function createSubagentResourceLoader(options: {
  file: string; cwd: string; agentDir: string; settingsManager: SettingsManager;
}): Promise<ResourceLoader> {
  const file = resolve(expandTilde(options.file));
  if (!existsSync(file)) throw new Error('Configured Pi subagent flow extension does not exist');
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    additionalExtensionPaths: [file],
    extensionsOverride: base => {
      const replacement = base.extensions.find(extension => resolve(extension.resolvedPath) === file);
      if (!replacement?.tools.has('subagent')) {
        throw new Error('Configured Pi subagent flow extension did not register subagent');
      }
      const replacedPaths = new Set(base.extensions.filter(extension => extension !== replacement).map(extension => extension.path));
      return {
        ...base,
        // SDK records duplicate-tool diagnostics before this intentional replacement.
        // Remove only the expected old-subagent collision, not other loader errors.
        errors: base.errors.filter(error => !(replacedPaths.has(error.path) &&
          error.error === `Tool "subagent" conflicts with ${file}`)),
        extensions: base.extensions.map(extension => {
          if (extension === replacement || !extension.tools.has('subagent')) return extension;
          const tools = new Map(extension.tools);
          tools.delete('subagent');
          return { ...extension, tools };
        }),
      };
    },
  });
  await loader.reload();
  return loader;
}

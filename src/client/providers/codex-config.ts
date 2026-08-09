import { spawnSync } from 'node:child_process';
import { type ConfigValueReader, createConfigValueReader } from '../../shared/config.js';
import type { CodexRuntimeOptions } from './codex-live-session.js';

export interface CodexProviderConfig extends CodexRuntimeOptions {
  codexPath?: string;
}

export interface LoadCodexProviderConfigOptions {
  defaultModel?: string;
  get?: ConfigValueReader;
  sandboxProbe?: CodexSandboxProbe;
  warn?: (message: string) => void;
}

export interface CodexSandboxProbeResult {
  supported: boolean;
  reason?: string;
}

export type CodexSandboxProbe = (codexPath?: string) => CodexSandboxProbeResult;

export function loadCodexProviderConfig(
  options: LoadCodexProviderConfigOptions = {},
): CodexProviderConfig {
  const get = options.get ?? createConfigValueReader('client');
  const model = get('TL_CODEX_MODEL', options.defaultModel ?? get('TL_DEFAULT_MODEL'));
  const codexPath = get('TL_CODEX_PATH');
  const sandboxMode = resolveCodexSandboxMode(
    get('TL_CODEX_SANDBOX_MODE', 'auto'),
    codexPath,
    options.sandboxProbe ?? probeCodexWorkspaceSandbox,
    options.warn ?? console.warn,
  );
  return {
    ...(model ? { model } : {}),
    ...(codexPath ? { codexPath } : {}),
    sandboxMode,
    approvalPolicy: normalizeCodexApprovalPolicy(get('TL_CODEX_APPROVAL_POLICY', 'on-request')),
    skipGitRepoCheck: get('TL_CODEX_SKIP_GIT_REPO_CHECK', 'false') === 'true',
    ...optional(
      'modelReasoningEffort',
      normalizeCodexReasoningEffort(get('TL_CODEX_REASONING_EFFORT')),
    ),
    ...optional('networkAccessEnabled', parseOptionalBoolean(get('TL_CODEX_NETWORK_ACCESS'))),
    ...optional('webSearchMode', normalizeCodexWebSearchMode(get('TL_CODEX_WEB_SEARCH'))),
  };
}

function resolveCodexSandboxMode(
  value: string | undefined,
  codexPath: string | undefined,
  probe: CodexSandboxProbe,
  warn: (message: string) => void,
): CodexRuntimeOptions['sandboxMode'] {
  if (value !== undefined && value !== '' && value !== 'auto') {
    return normalizeCodexSandboxMode(value);
  }

  const result = probe(codexPath);
  if (result.supported) return 'workspace-write';

  const reason = result.reason ? ` (${result.reason})` : '';
  warn(
    `[codex-sdk] Codex workspace sandbox is unavailable${reason}; ` +
      'falling back to danger-full-access. Set TL_CODEX_SANDBOX_MODE=workspace-write ' +
      'to require strict sandboxing.',
  );
  return 'danger-full-access';
}

export function probeCodexWorkspaceSandbox(
  codexPath?: string,
  platform: NodeJS.Platform = process.platform,
): CodexSandboxProbeResult {
  if (platform !== 'linux') return { supported: true };

  const executable = codexPath?.trim() || 'codex';
  const options = {
    encoding: 'utf8',
    timeout: 5000,
  } as const;
  let result = spawnSync(executable, ['sandbox', '--', '/bin/true'], options);
  let output = sandboxProbeOutput(result);

  // Codex CLI <= 0.132 exposes the platform as a required sandbox subcommand.
  if (isLegacyCodexSandboxSyntax(output)) {
    result = spawnSync(executable, ['sandbox', 'linux', '--', '/bin/true'], options);
    output = sandboxProbeOutput(result);
  }

  if (result.status === 0) return { supported: true };
  const knownPermissionFailure =
    /bwrap:.*(?:Operation not permitted|Permission denied)/i.test(output) ||
    /creating new namespace failed:.*Operation not permitted/i.test(output);
  if (!knownPermissionFailure) return { supported: true };

  const detail = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return { supported: false, ...(detail ? { reason: detail } : {}) };
}

function sandboxProbeOutput(result: {
  stderr?: string | Buffer;
  stdout?: string | Buffer;
}): string {
  return `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
}

function isLegacyCodexSandboxSyntax(output: string): boolean {
  return /unrecognized subcommand ['"]?\/bin\/true['"]?/i.test(output);
}

function optional<K extends keyof CodexProviderConfig>(
  key: K,
  value: CodexProviderConfig[K] | undefined,
): Pick<CodexProviderConfig, K> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Pick<CodexProviderConfig, K>);
}

function normalizeCodexSandboxMode(value: string | undefined): CodexRuntimeOptions['sandboxMode'] {
  if (value === 'read-only' || value === 'danger-full-access') return value;
  return 'workspace-write';
}

function normalizeCodexApprovalPolicy(
  value: string | undefined,
): CodexRuntimeOptions['approvalPolicy'] {
  if (value === 'never' || value === 'on-failure' || value === 'untrusted') return value;
  return 'on-request';
}

function normalizeCodexReasoningEffort(
  value: string | undefined,
): CodexRuntimeOptions['modelReasoningEffort'] {
  if (
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  ) {
    return value;
  }
  return undefined;
}

function normalizeCodexWebSearchMode(
  value: string | undefined,
): CodexRuntimeOptions['webSearchMode'] {
  if (value === 'disabled' || value === 'cached' || value === 'live') return value;
  return undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return value === 'true';
}

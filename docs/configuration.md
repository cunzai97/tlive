# Configuration Options

Config files:

- `~/.tlive/server.env`: Feishu bridge and control-plane values
- `~/.tlive/client.env`: execution client values
- `~/.tlive/config.env`: legacy file, used only for one-time migration

Runtime reads only the role-specific file for the process. Shell environment variables override
that file. If `config.env` exists and either `server.env` or `client.env` is missing, startup
creates the missing role file from `config.env` once and then reads only the role file.

## Basic Settings

```env
# ~/.tlive/server.env
TL_TOKEN=auto-generated

# Completed/failed task card buttons.
# Default is only the workbench button. Add more if needed.
# Supported: home,new,help,perm,none
TL_DONE_BUTTONS=home
```

## Feishu / Lark

```env
# ~/.tlive/server.env
TL_FS_APP_ID=cli_xxx
TL_FS_APP_SECRET=xxx
TL_FS_VERIFICATION_TOKEN=
TL_FS_ENCRYPT_KEY=
TL_FS_AUTO_PIN_TOPIC=true

# Optional user whitelist: open_id or user_id, comma-separated
TL_FS_ALLOWED_USERS=ou_xxx,xxx
```

See [Feishu Setup Guide](setup-feishu.md).

## Agent Settings

```env
# ~/.tlive/client.env
TL_PROVIDER=claude
# or: codex, pi

# Settings sources loaded by default for new chats
# user    = ~/.claude/settings.json
# project = .claude/settings.json + CLAUDE.md + project MCP config
# local   = .claude/settings.local.json
TL_AGENT_SETTINGS=user,project,local
```

Use `/settings user|full|isolated` to override Claude settings for the current chat only:

- `user`: auth/model config only
- `full`: user + project + local settings
- `isolated`: ignore external settings for this chat

Codex provider options:

```env
# ~/.tlive/client.env
TL_CODEX_MODEL=
TL_CODEX_PATH=
TL_CODEX_SANDBOX_MODE=auto
TL_CODEX_APPROVAL_POLICY=on-request
TL_CODEX_SKIP_GIT_REPO_CHECK=false
TL_CODEX_REASONING_EFFORT=
TL_CODEX_NETWORK_ACCESS=
TL_CODEX_WEB_SEARCH=
```

On Linux, `auto` probes the Codex `workspace-write` sandbox. If bwrap/AppArmor rejects the
required namespace setup, TLive warns and falls back to `danger-full-access`. This removes the
Codex filesystem sandbox. Set `workspace-write` explicitly to prohibit that fallback and require
the host sandbox policy to be fixed instead.

Pi provider options:

```env
# ~/.tlive/client.env
TL_PI_AGENT_DIR=
TL_PI_SESSION_DIR=
TL_PI_PROVIDER=
TL_PI_MODEL=
TL_PI_THINKING=
TL_PI_NO_SESSION=false
TL_PI_OFFLINE=false
```

## MCP

```env
# ~/.tlive/server.env
TL_MCP_ENABLED=true
TL_MCP_PORT=8081
TL_MCP_PATH=/mcp
TL_MCP_TOKEN=
TL_MCP_MAX_FILE_MB=20
```

## Execution Clients

The server always listens for execution clients. `tlive start` and `tlive server` also start a
local client unless `--standalone` is passed.

```env
# ~/.tlive/server.env
TL_REMOTE_SERVER_PORT=8787
TL_REMOTE_SERVER_PATH=/tlive
TL_REMOTE_TOKEN=

# ~/.tlive/client.env
TL_REMOTE_SERVER_URL=ws://your-server:8787/tlive
TL_REMOTE_TOKEN=
TL_REMOTE_CLIENT_ID=
TL_REMOTE_CLIENT_NAME=
TL_REMOTE_CLIENT_NOTE=
TL_DEFAULT_MODEL=
TL_DEFAULT_WORKDIR=/path/to/default/project
TL_REMOTE_WORKSPACES=/path/to/quick-project
```

Worker clients auto-detect available local providers. `TL_DEFAULT_WORKDIR` is the default
directory for new sessions on that client. `TL_REMOTE_WORKSPACES` is only a list of quick
directories shown in the workbench; it does not limit `/cd`.

## Security

```bash
chmod 600 ~/.tlive/*.env
```

Sensitive info in config is automatically redacted before sending to IM.

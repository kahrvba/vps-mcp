# VPS MCP Server

An MCP server that enables an AI agent to connect to and control a VPS (Virtual Private Server) via SSH.

## Tools

### Session Management
- **`connect_vps`**: Establish SSH connection (Host, Port, User, Password/Key).
- **`disconnect_vps`**: Close the session.

### File System Operations
- **`list_directory`**: List files/folders in a path (supports relative paths to CWD).
- **`create_directory`**: Create a new directory.
- **`read_file`**: Read file contents.
- **`write_file`**: Create or overwrite a file with content.
- **`delete_item`**: Recursively delete a file or directory.
- **`change_directory`**: Change the current working directory for subsequent commands.
- **`get_current_directory`**: Get the current tracked working directory.

### Command Execution
- **`execute_command`**: Run shell commands. 
  - **Note**: Commands are automatically prefixed with `cd <current_working_directory>`. 
  - To change directory persistently, use `change_directory` instead of running `cd` here.

### Database Operations (Local VPS)
- **`db_detect_engines`**: Detect PostgreSQL CLI availability.
- **`db_bootstrap_users_profiles`**: Idempotently create `users` and `profiles` tables.
- **`db_create_user_with_profile`**: Upsert user + profile by email.
- **`db_get_user_with_profile`**: Fetch joined user/profile data.
- **`db_update_user_profile`**: Update `fullName` and/or `bio`.
- **`db_delete_user_with_profile_prepare`** + **`db_delete_user_with_profile_confirm`**: Two-step destructive delete.

### Cloudflare Runtime Operations (Already Authenticated VPS)
- **`cloudflare_tunnel_status`**: Check cloudflared process + service status.
- **`cloudflare_tunnel_logs`**: Read recent cloudflared logs.
- **`cloudflare_tunnel_config_test`**: Validate active cloudflared config.
- **`cloudflare_tunnel_restart_prepare`** + **`cloudflare_tunnel_restart_confirm`**: Two-step service restart.
- **`cloudflare_tunnel_route_dns`**: Manage tunnel DNS routing via `cloudflared`.

### Port / Network Operations
- **`ports_inventory`**: Show listeners, firewall rules, and docker mappings.
- **`ports_open_prepare`** + **`ports_open_confirm`**: Open firewall port (UFW).
- **`ports_close_prepare`** + **`ports_close_confirm`**: Close firewall port (UFW).
- **`ports_kill_process_prepare`** + **`ports_kill_process_confirm`**: Kill process bound to port.
- **`ports_reconcile`**: Compare listener ports vs firewall state.

### Systemd Operations
- **`systemd_list_services`**: List service units.
- **`systemd_service_status`**: Get detailed status for a service.
- **`systemd_service_action_prepare`** + **`systemd_service_action_confirm`**: Start/stop/restart/enable/disable a service.
- **`systemd_create_service`**: Create or overwrite `/etc/systemd/system/<name>.service`, reload daemon, optionally enable/start.
- **`systemd_delete_service_prepare`** + **`systemd_delete_service_confirm`**: Disable/remove a service file and reload daemon.

### Safety Workflow
Destructive tools use a two-step model:
1. Call a `*_prepare` tool to get an `op_id` and execution summary.
2. Call matching `*_confirm` with `op_id` before expiry (10 minutes).

## Usage

Add the following configuration to your MCP client (e.g., Claude Desktop config file):

```json
{
  "mcpServers": {
    "vps": {
      "command": "npx",
      "args": ["-y", "vps-mcp"]
    }
  }
}
```

### Persistent / Hosted Mode (HTTP MCP)
Run as a long-lived remote MCP service:

```bash
npm run build
MCP_TRANSPORT=http MCP_HOST=0.0.0.0 MCP_PORT=59450 node dist/index.js
```

Notes:
- HTTP mode runs on `/mcp` with Streamable HTTP transport.
- New ops tools return JSON-formatted text for easier agent parsing.

Health check:

```bash
curl http://127.0.0.1:59450/health
```

## Support

If you find this project useful, consider supporting me on Patreon:

[![Patreon](https://img.shields.io/badge/Patreon-Donate-FF5722)](https://patreon.com/harjjot) or click [here](https://patreon.com/harjjot) to donate.

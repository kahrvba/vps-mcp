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

## Support

If you find this project useful, consider supporting me on Patreon:

[![Patreon](https://img.shields.io/badge/Patreon-Donate-FF5722)](https://patreon.com/harjjot) or click [here](https://patreon.com/harjjot) to donate.
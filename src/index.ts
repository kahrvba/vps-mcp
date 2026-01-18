#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SshClient } from './ssh.js';

const sshClient = new SshClient();

const server = new Server(
  {
    name: 'vps-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define Tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'connect_vps',
        description: 'Connect to a VPS using SSH. Requires host, username, and either password or privateKey.',
        inputSchema: {
          type: 'object',
          properties: {
            host: {
              type: 'string',
              description: 'Hostname or IP address of the VPS',
            },
            port: {
              type: 'number',
              description: 'SSH port (default: 22)',
              default: 22,
            },
            username: {
              type: 'string',
              description: 'SSH username',
            },
            password: {
              type: 'string',
              description: 'SSH password (optional if privateKey provided)',
            },
            privateKey: {
              type: 'string',
              description: 'SSH private key (optional if password provided)',
            },
          },
          required: ['host', 'username'],
        },
      },
      {
        name: 'disconnect_vps',
        description: 'Disconnect from the current VPS session.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'execute_command',
        description: 'Execute a shell command on the connected VPS and return the output. Runs in the current tracked directory.',
        inputSchema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The shell command to execute',
            },
          },
          required: ['command'],
        },
      },
      {
        name: 'list_directory',
        description: 'List contents of a directory on the VPS. Defaults to current working directory.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to list (relative to CWD or absolute).',
            },
          },
        },
      },
      {
        name: 'create_directory',
        description: 'Create a new directory on the VPS.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path of the directory to create.',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'read_file',
        description: 'Read the contents of a file on the VPS.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file.',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Create or overwrite a file on the VPS.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file.',
            },
            content: {
              type: 'string',
              description: 'Content to write to the file.',
            },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'delete_item',
        description: 'Delete a file or directory on the VPS (recursive).',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file or directory to delete.',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'change_directory',
        description: 'Change the current working directory on the VPS.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Target directory path.',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'get_current_directory',
        description: 'Get the current working directory path.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// Handle Tool Calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case 'connect_vps': {
        const args = z
          .object({
            host: z.string(),
            port: z.number().default(22),
            username: z.string(),
            password: z.string().optional(),
            privateKey: z.string().optional(),
          })
          .parse(request.params.arguments);

        if (!args.password && !args.privateKey) {
            throw new McpError(ErrorCode.InvalidParams, 'Either password or privateKey must be provided');
        }

        if (sshClient.isConnected()) {
            sshClient.disconnect();
        }

        await sshClient.connect({
            host: args.host,
            port: args.port,
            username: args.username,
            password: args.password,
            privateKey: args.privateKey,
        });

        return {
          content: [
            {
              type: 'text',
              text: `Successfully connected to ${args.username}@${args.host}. CWD: ${sshClient.getCwd()}`,
            },
          ],
        };
      }

      case 'disconnect_vps': {
        sshClient.disconnect();
        return {
          content: [
            {
              type: 'text',
              text: 'Disconnected from VPS',
            },
          ],
        };
      }

      case 'execute_command': {
        const args = z
          .object({
            command: z.string(),
          })
          .parse(request.params.arguments);

        const result = await sshClient.executeCommand(args.command);

        return {
          content: [
            {
              type: 'text',
              text: `STDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}\n\nExit Code: ${result.code}`,
            },
          ],
        };
      }

      case 'list_directory': {
        const args = z
          .object({
            path: z.string().optional(),
          })
          .parse(request.params.arguments);

        const files = await sshClient.listFiles(args.path || '.');
        const formattedList = files.map(f => {
            const type = f.attrs.isDirectory() ? 'DIR' : 'FILE';
            return `[${type}] ${f.filename} (Size: ${f.attrs.size})`;
        }).join('\n');

        return {
          content: [
            {
              type: 'text',
              text: formattedList || '(Empty directory)',
            },
          ],
        };
      }

      case 'create_directory': {
        const args = z.object({ path: z.string() }).parse(request.params.arguments);
        await sshClient.createDirectory(args.path);
        return { content: [{ type: 'text', text: `Directory created: ${args.path}` }] };
      }

      case 'read_file': {
        const args = z.object({ path: z.string() }).parse(request.params.arguments);
        const content = await sshClient.readFile(args.path);
        return { content: [{ type: 'text', text: content }] };
      }

      case 'write_file': {
        const args = z.object({ path: z.string(), content: z.string() }).parse(request.params.arguments);
        await sshClient.writeFile(args.path, args.content);
        return { content: [{ type: 'text', text: `File written: ${args.path}` }] };
      }

      case 'delete_item': {
        const args = z.object({ path: z.string() }).parse(request.params.arguments);
        await sshClient.deleteItem(args.path);
        return { content: [{ type: 'text', text: `Item deleted: ${args.path}` }] };
      }

      case 'change_directory': {
        const args = z.object({ path: z.string() }).parse(request.params.arguments);
        const newCwd = await sshClient.changeDirectory(args.path);
        return { content: [{ type: 'text', text: `Changed directory to: ${newCwd}` }] };
      }

      case 'get_current_directory': {
        return { content: [{ type: 'text', text: sshClient.getCwd() }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (error: any) {
    if (error instanceof z.ZodError) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${error.message}`);
    }
    return {
        content: [
            {
                type: 'text',
                text: `Error: ${error.message}`,
            }
        ],
        isError: true,
    }
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('VPS MCP Server running on stdio');
}

run().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});
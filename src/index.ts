#!/usr/bin/env node
import { randomUUID } from 'crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
    version: '1.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type PendingOperation = {
  id: string;
  kind: string;
  command: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
};

const OP_TTL_MS = 10 * 60 * 1000;
const pendingOps = new Map<string, PendingOperation>();
const PENDING_OPS_FILE = process.env.MCP_PENDING_OPS_FILE || '.data/pending-ops.json';

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function toTextResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function toJsonResult(payload: unknown, isError = false) {
  return toTextResult(JSON.stringify(payload, null, 2), isError);
}

async function runCommand(command: string) {
  return sshClient.executeCommand(command);
}

async function runCommandOrThrow(command: string, label: string): Promise<string> {
  const result = await runCommand(command);
  if (result.code !== 0) {
    throw new Error(`${label} failed (exit ${String(result.code)}): ${result.stderr || result.stdout || 'Unknown error'}`);
  }
  return result.stdout.trim();
}

function requireConnected(): void {
  if (!sshClient.isConnected()) {
    throw new McpError(ErrorCode.InvalidRequest, 'Not connected to VPS. Use connect_vps first.');
  }
}

function createPendingOp(kind: string, command: string, summary: string): PendingOperation {
  const now = Date.now();
  const op: PendingOperation = {
    id: randomUUID(),
    kind,
    command,
    summary,
    createdAt: now,
    expiresAt: now + OP_TTL_MS,
  };
  pendingOps.set(op.id, op);
  return op;
}

function getPendingOp(id: string, kind: string): PendingOperation {
  const op = pendingOps.get(id);
  if (!op) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown op_id: ${id}`);
  }
  if (op.kind !== kind) {
    throw new McpError(ErrorCode.InvalidParams, `op_id kind mismatch. Expected ${kind}, got ${op.kind}`);
  }
  if (Date.now() > op.expiresAt) {
    pendingOps.delete(id);
    throw new McpError(ErrorCode.InvalidParams, `op_id expired: ${id}`);
  }
  return op;
}

function consumePendingOp(id: string): void {
  pendingOps.delete(id);
}

async function ensurePendingOpsDir(): Promise<void> {
  const idx = PENDING_OPS_FILE.lastIndexOf('/');
  if (idx <= 0) {
    return;
  }
  const dir = PENDING_OPS_FILE.slice(0, idx);
  await mkdir(dir, { recursive: true });
}

async function savePendingOps(): Promise<void> {
  await ensurePendingOpsDir();
  const ops = Array.from(pendingOps.values());
  await writeFile(PENDING_OPS_FILE, JSON.stringify(ops, null, 2), 'utf8');
}

async function loadPendingOps(): Promise<void> {
  try {
    const raw = await readFile(PENDING_OPS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as PendingOperation[];
    const now = Date.now();
    for (const op of parsed) {
      if (op.expiresAt > now) {
        pendingOps.set(op.id, op);
      }
    }
    await savePendingOps();
  } catch {
    // No persisted state yet; start clean.
  }
}

async function persistCreatePendingOp(kind: string, command: string, summary: string): Promise<PendingOperation> {
  const op = createPendingOp(kind, command, summary);
  await savePendingOps();
  return op;
}

async function persistConsumePendingOp(id: string): Promise<void> {
  consumePendingOp(id);
  await savePendingOps();
}

function oldTools(): ToolDef[] {
  return [
    {
      name: 'connect_vps',
      description: 'Open an SSH session to a VPS.',
      inputSchema: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Hostname or IP address of the VPS' },
          port: { type: 'number', description: 'SSH port (default: 22)', default: 22 },
          username: { type: 'string', description: 'SSH username' },
          password: { type: 'string', description: 'SSH password (optional if privateKey provided)' },
          privateKey: { type: 'string', description: 'SSH private key (optional if password provided)' },
        },
        required: ['host', 'username'],
      },
    },
    {
      name: 'disconnect_vps',
      description: 'Close the active SSH session.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'execute_command',
      description: 'Run a shell command in the tracked working directory.',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to execute' } },
        required: ['command'],
      },
    },
    {
      name: 'list_directory',
      description: 'List files and folders in a directory.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to list (relative to CWD or absolute).' },
        },
      },
    },
    {
      name: 'create_directory',
      description: 'Create a directory.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path of the directory to create.' } },
        required: ['path'],
      },
    },
    {
      name: 'read_file',
      description: 'Read a text file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path to the file.' } },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a text file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file.' },
          content: { type: 'string', description: 'Content to write to the file.' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'delete_item',
      description: 'Delete a file or directory recursively.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path to the file or directory to delete.' } },
        required: ['path'],
      },
    },
    {
      name: 'change_directory',
      description: 'Set the tracked working directory.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Target directory path.' } },
        required: ['path'],
      },
    },
    {
      name: 'get_current_directory',
      description: 'Get the tracked working directory path.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

function extendedTools(): ToolDef[] {
  return [
    {
      name: 'systemd_list_services',
      description: 'List systemd service units.',
      inputSchema: {
        type: 'object',
        properties: {
          all: { type: 'boolean', default: false },
        },
      },
    },
    {
      name: 'systemd_service_status',
      description: 'Show detailed status for a systemd service.',
      inputSchema: {
        type: 'object',
        properties: {
          serviceName: { type: 'string' },
        },
        required: ['serviceName'],
      },
    },
    {
      name: 'systemd_service_action_prepare',
      description: 'Prepare a systemd service action.',
      inputSchema: {
        type: 'object',
        properties: {
          serviceName: { type: 'string' },
          action: { type: 'string', enum: ['start', 'stop', 'restart', 'enable', 'disable'] },
        },
        required: ['serviceName', 'action'],
      },
    },
    {
      name: 'systemd_service_action_confirm',
      description: 'Confirm a prepared systemd service action.',
      inputSchema: {
        type: 'object',
        properties: {
          op_id: { type: 'string' },
        },
        required: ['op_id'],
      },
    },
    {
      name: 'systemd_create_service',
      description: 'Create or overwrite /etc/systemd/system/<service>.service and reload daemon.',
      inputSchema: {
        type: 'object',
        properties: {
          serviceName: { type: 'string' },
          unitContent: { type: 'string' },
          enableNow: { type: 'boolean', default: false },
          startNow: { type: 'boolean', default: false },
        },
        required: ['serviceName', 'unitContent'],
      },
    },
    {
      name: 'systemd_delete_service_prepare',
      description: 'Prepare deletion of a systemd service file.',
      inputSchema: {
        type: 'object',
        properties: {
          serviceName: { type: 'string' },
        },
        required: ['serviceName'],
      },
    },
    {
      name: 'systemd_delete_service_confirm',
      description: 'Confirm deletion of a prepared systemd service file.',
      inputSchema: {
        type: 'object',
        properties: {
          op_id: { type: 'string' },
        },
        required: ['op_id'],
      },
    },
    {
      name: 'db_detect_engines',
      description: 'Detect PostgreSQL CLI availability.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'db_bootstrap_users_profiles',
      description: 'Create users/profiles tables if missing.',
      inputSchema: {
        type: 'object',
        properties: {
          database: { type: 'string' },
          dbUser: { type: 'string' },
          dbPassword: { type: 'string' },
        },
        required: ['database'],
      },
    },
    {
      name: 'db_create_user_with_profile',
      description: 'Upsert a user and profile by email.',
      inputSchema: {
        type: 'object',
        properties: {
          database: { type: 'string' },
          dbUser: { type: 'string' },
          dbPassword: { type: 'string' },
          email: { type: 'string' },
          fullName: { type: 'string' },
          bio: { type: 'string' },
        },
        required: ['database', 'email', 'fullName'],
      },
    },
    {
      name: 'db_get_user_with_profile',
      description: 'Get user and profile data by email.',
      inputSchema: {
        type: 'object',
        properties: {
          database: { type: 'string' },
          dbUser: { type: 'string' },
          dbPassword: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['database', 'email'],
      },
    },
    {
      name: 'db_update_user_profile',
      description: 'Update profile fields for a user email.',
      inputSchema: {
        type: 'object',
        properties: {
          database: { type: 'string' },
          dbUser: { type: 'string' },
          dbPassword: { type: 'string' },
          email: { type: 'string' },
          fullName: { type: 'string' },
          bio: { type: 'string' },
        },
        required: ['database', 'email'],
      },
    },
    {
      name: 'db_delete_user_with_profile_prepare',
      description: 'Prepare deleting a user and profile.',
      inputSchema: {
        type: 'object',
        properties: {
          database: { type: 'string' },
          dbUser: { type: 'string' },
          dbPassword: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['database', 'email'],
      },
    },
    {
      name: 'db_delete_user_with_profile_confirm',
      description: 'Confirm a prepared user/profile delete.',
      inputSchema: {
        type: 'object',
        properties: { op_id: { type: 'string' } },
        required: ['op_id'],
      },
    },
    {
      name: 'cloudflare_tunnel_status',
      description: 'Show cloudflared service and process status.',
      inputSchema: {
        type: 'object',
        properties: { serviceName: { type: 'string', default: 'cloudflared' } },
      },
    },
    {
      name: 'cloudflare_tunnel_logs',
      description: 'Read recent cloudflared logs.',
      inputSchema: {
        type: 'object',
        properties: {
          serviceName: { type: 'string', default: 'cloudflared' },
          lines: { type: 'number', default: 100 },
        },
      },
    },
    {
      name: 'cloudflare_tunnel_config_test',
      description: 'Validate cloudflared config file.',
      inputSchema: {
        type: 'object',
        properties: { configPath: { type: 'string', default: '/etc/cloudflared/config.yml' } },
      },
    },
    {
      name: 'cloudflare_tunnel_restart_prepare',
      description: 'Prepare cloudflared service restart.',
      inputSchema: {
        type: 'object',
        properties: { serviceName: { type: 'string', default: 'cloudflared' } },
      },
    },
    {
      name: 'cloudflare_tunnel_restart_confirm',
      description: 'Confirm a prepared cloudflared restart.',
      inputSchema: {
        type: 'object',
        properties: { op_id: { type: 'string' } },
        required: ['op_id'],
      },
    },
    {
      name: 'cloudflare_tunnel_route_dns',
      description: 'Route a hostname to an existing tunnel.',
      inputSchema: {
        type: 'object',
        properties: {
          tunnel: { type: 'string' },
          hostname: { type: 'string' },
          overwrite: { type: 'boolean', default: false },
        },
        required: ['tunnel', 'hostname'],
      },
    },
    {
      name: 'ports_inventory',
      description: 'Show listener ports, docker mappings, and firewall state.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ports_open_prepare',
      description: 'Prepare opening a firewall port.',
      inputSchema: {
        type: 'object',
        properties: {
          port: { type: 'number' },
          protocol: { type: 'string', enum: ['tcp', 'udp'], default: 'tcp' },
        },
        required: ['port'],
      },
    },
    {
      name: 'ports_open_confirm',
      description: 'Confirm a prepared firewall port open.',
      inputSchema: { type: 'object', properties: { op_id: { type: 'string' } }, required: ['op_id'] },
    },
    {
      name: 'ports_close_prepare',
      description: 'Prepare closing a firewall port.',
      inputSchema: {
        type: 'object',
        properties: {
          port: { type: 'number' },
          protocol: { type: 'string', enum: ['tcp', 'udp'], default: 'tcp' },
        },
        required: ['port'],
      },
    },
    {
      name: 'ports_close_confirm',
      description: 'Confirm a prepared firewall port close.',
      inputSchema: { type: 'object', properties: { op_id: { type: 'string' } }, required: ['op_id'] },
    },
    {
      name: 'ports_kill_process_prepare',
      description: 'Prepare killing process(es) bound to a port.',
      inputSchema: {
        type: 'object',
        properties: { port: { type: 'number' }, force: { type: 'boolean', default: false } },
        required: ['port'],
      },
    },
    {
      name: 'ports_kill_process_confirm',
      description: 'Confirm a prepared port process kill.',
      inputSchema: { type: 'object', properties: { op_id: { type: 'string' } }, required: ['op_id'] },
    },
    {
      name: 'ports_reconcile',
      description: 'Compare active listeners with firewall allow rules.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [...oldTools(), ...extendedTools()],
  };
});

async function executeDbSql(database: string, sql: string, dbUser?: string, dbPassword?: string): Promise<string> {
  const userPart = dbUser ? ` -U ${shQuote(dbUser)}` : '';
  const passPrefix = dbPassword ? `PGPASSWORD=${shQuote(dbPassword)} ` : '';
  const cmd = `${passPrefix}psql -At -d ${shQuote(database)}${userPart} -c ${shQuote(sql)}`;
  return runCommandOrThrow(cmd, 'PostgreSQL query');
}

function validateServiceName(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-zA-Z0-9._@-]+$/.test(trimmed)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid serviceName format');
  }
  return trimmed.endsWith('.service') ? trimmed : `${trimmed}.service`;
}

function bootstrapSql(): string {
  return `
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  bio TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
}

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
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

        return toTextResult(`Successfully connected to ${args.username}@${args.host}. CWD: ${sshClient.getCwd()}`);
      }

      case 'disconnect_vps': {
        sshClient.disconnect();
        return toTextResult('Disconnected from VPS');
      }

      case 'execute_command': {
        requireConnected();
        const args = z.object({ command: z.string() }).parse(request.params.arguments);
        const result = await runCommand(args.command);
        return toTextResult(`STDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}\n\nExit Code: ${result.code}`);
      }

      case 'list_directory': {
        requireConnected();
        const args = z.object({ path: z.string().optional() }).parse(request.params.arguments);
        const files = await sshClient.listFiles(args.path || '.');
        const formattedList = files
          .map((f) => {
            const type = f.attrs.isDirectory() ? 'DIR' : 'FILE';
            return `[${type}] ${f.filename} (Size: ${f.attrs.size})`;
          })
          .join('\n');

        return toTextResult(formattedList || '(Empty directory)');
      }

      case 'create_directory': {
        requireConnected();
        const args = z.object({ path: z.string() }).parse(request.params.arguments);
        await sshClient.createDirectory(args.path);
        return toTextResult(`Directory created: ${args.path}`);
      }

      case 'read_file': {
        requireConnected();
        const args = z.object({ path: z.string() }).parse(request.params.arguments);
        const content = await sshClient.readFile(args.path);
        return toTextResult(content);
      }

      case 'write_file': {
        requireConnected();
        const args = z.object({ path: z.string(), content: z.string() }).parse(request.params.arguments);
        await sshClient.writeFile(args.path, args.content);
        return toTextResult(`File written: ${args.path}`);
      }

      case 'delete_item': {
        requireConnected();
        const args = z.object({ path: z.string() }).parse(request.params.arguments);
        await sshClient.deleteItem(args.path);
        return toTextResult(`Item deleted: ${args.path}`);
      }

      case 'change_directory': {
        requireConnected();
        const args = z.object({ path: z.string() }).parse(request.params.arguments);
        const newCwd = await sshClient.changeDirectory(args.path);
        return toTextResult(`Changed directory to: ${newCwd}`);
      }

      case 'get_current_directory': {
        return toTextResult(sshClient.getCwd());
      }

      case 'systemd_list_services': {
        requireConnected();
        const args = z.object({ all: z.boolean().default(false) }).parse(request.params.arguments);
        const allFlag = args.all ? '--all' : '';
        const out = await runCommand(`systemctl list-units --type=service ${allFlag} --no-pager --no-legend`);
        return toJsonResult({ ok: out.code === 0, stdout: out.stdout, stderr: out.stderr, exit_code: out.code });
      }

      case 'systemd_service_status': {
        requireConnected();
        const args = z.object({ serviceName: z.string() }).parse(request.params.arguments);
        const service = validateServiceName(args.serviceName);
        const out = await runCommand(`systemctl status ${shQuote(service)} --no-pager -l || true`);
        return toJsonResult({ ok: true, service, status: out.stdout, stderr: out.stderr, exit_code: out.code });
      }

      case 'systemd_service_action_prepare': {
        requireConnected();
        const args = z
          .object({
            serviceName: z.string(),
            action: z.enum(['start', 'stop', 'restart', 'enable', 'disable']),
          })
          .parse(request.params.arguments);
        const service = validateServiceName(args.serviceName);
        const cmd = `sudo systemctl ${args.action} ${shQuote(service)} && systemctl is-enabled ${shQuote(service)} 2>/dev/null || true && systemctl is-active ${shQuote(service)} 2>/dev/null || true`;
        const op = await persistCreatePendingOp('systemd_service_action', cmd, `${args.action} ${service}`);
        return toJsonResult({
          ok: true,
          op_id: op.id,
          kind: op.kind,
          summary: op.summary,
          expires_in_seconds: Math.floor((op.expiresAt - Date.now()) / 1000),
        });
      }

      case 'systemd_service_action_confirm': {
        requireConnected();
        const args = z.object({ op_id: z.string() }).parse(request.params.arguments);
        const op = getPendingOp(args.op_id, 'systemd_service_action');
        const out = await runCommandOrThrow(op.command, op.summary);
        await persistConsumePendingOp(op.id);
        return toJsonResult({ ok: true, summary: op.summary, output: out || '' });
      }

      case 'systemd_create_service': {
        requireConnected();
        const args = z
          .object({
            serviceName: z.string(),
            unitContent: z.string().min(1),
            enableNow: z.boolean().default(false),
            startNow: z.boolean().default(false),
          })
          .parse(request.params.arguments);
        const service = validateServiceName(args.serviceName);
        const b64 = Buffer.from(args.unitContent, 'utf8').toString('base64');
        const target = `/etc/systemd/system/${service}`;
        let cmd = `echo ${shQuote(b64)} | base64 -d | sudo tee ${shQuote(target)} >/dev/null && sudo systemctl daemon-reload`;
        if (args.enableNow) {
          cmd += ` && sudo systemctl enable ${shQuote(service)}`;
        }
        if (args.startNow) {
          cmd += ` && sudo systemctl start ${shQuote(service)}`;
        }
        cmd += ` && systemctl status ${shQuote(service)} --no-pager -l || true`;
        const out = await runCommand(cmd);
        return toJsonResult({ ok: out.code === 0, service, path: target, stdout: out.stdout, stderr: out.stderr, exit_code: out.code });
      }

      case 'systemd_delete_service_prepare': {
        requireConnected();
        const args = z.object({ serviceName: z.string() }).parse(request.params.arguments);
        const service = validateServiceName(args.serviceName);
        const target = `/etc/systemd/system/${service}`;
        const cmd = `sudo systemctl disable --now ${shQuote(service)} 2>/dev/null || true; sudo rm -f ${shQuote(target)} && sudo systemctl daemon-reload`;
        const op = await persistCreatePendingOp('systemd_delete_service', cmd, `Delete ${target}`);
        return toJsonResult({
          ok: true,
          op_id: op.id,
          kind: op.kind,
          summary: op.summary,
          expires_in_seconds: Math.floor((op.expiresAt - Date.now()) / 1000),
        });
      }

      case 'systemd_delete_service_confirm': {
        requireConnected();
        const args = z.object({ op_id: z.string() }).parse(request.params.arguments);
        const op = getPendingOp(args.op_id, 'systemd_delete_service');
        const out = await runCommandOrThrow(op.command, op.summary);
        await persistConsumePendingOp(op.id);
        return toJsonResult({ ok: true, summary: op.summary, output: out || '' });
      }

      case 'db_detect_engines': {
        requireConnected();
        const result = await runCommand(`command -v psql >/dev/null 2>&1 && echo postgres:available || echo postgres:missing`);
        const state = result.stdout.trim().split(':')[1] || 'missing';
        return toJsonResult({ ok: result.code === 0, postgres: state, stderr: result.stderr.trim() || undefined });
      }

      case 'db_bootstrap_users_profiles': {
        requireConnected();
        const args = z
          .object({
            database: z.string(),
            dbUser: z.string().optional(),
            dbPassword: z.string().optional(),
          })
          .parse(request.params.arguments);

        const out = await executeDbSql(args.database, bootstrapSql(), args.dbUser, args.dbPassword);
        return toTextResult(`Bootstrap completed for postgres/${args.database}.\n${out || '(no output)'}`);
      }

      case 'db_create_user_with_profile': {
        requireConnected();
        const args = z
          .object({
            database: z.string(),
            dbUser: z.string().optional(),
            dbPassword: z.string().optional(),
            email: z.string().email(),
            fullName: z.string(),
            bio: z.string().optional(),
          })
          .parse(request.params.arguments);

        const sql = `
WITH inserted_user AS (
  INSERT INTO users (email)
  VALUES (${shQuote(args.email)})
  ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
  RETURNING id
)
INSERT INTO profiles (user_id, full_name, bio)
SELECT id, ${shQuote(args.fullName)}, ${shQuote(args.bio ?? '')}
FROM inserted_user
ON CONFLICT (user_id) DO UPDATE
SET full_name = EXCLUDED.full_name,
    bio = EXCLUDED.bio,
    updated_at = NOW();
`;

        const out = await executeDbSql(args.database, sql, args.dbUser, args.dbPassword);
        return toTextResult(`User/profile upserted for ${args.email}.\n${out || '(no output)'}`);
      }

      case 'db_get_user_with_profile': {
        requireConnected();
        const args = z
          .object({
            database: z.string(),
            dbUser: z.string().optional(),
            dbPassword: z.string().optional(),
            email: z.string().email(),
          })
          .parse(request.params.arguments);

        const sql = `
SELECT u.id, u.email, u.created_at, p.full_name, p.bio, p.updated_at
FROM users u
LEFT JOIN profiles p ON p.user_id = u.id
WHERE u.email = ${shQuote(args.email)};
`;
        const out = await executeDbSql(args.database, sql, args.dbUser, args.dbPassword);
        return toTextResult(out || '(not found)');
      }

      case 'db_update_user_profile': {
        requireConnected();
        const args = z
          .object({
            database: z.string(),
            dbUser: z.string().optional(),
            dbPassword: z.string().optional(),
            email: z.string().email(),
            fullName: z.string().optional(),
            bio: z.string().optional(),
          })
          .parse(request.params.arguments);

        if (!args.fullName && args.bio === undefined) {
          throw new McpError(ErrorCode.InvalidParams, 'Provide at least one field: fullName or bio');
        }

        const fullNameExpr = args.fullName ? shQuote(args.fullName) : 'p.full_name';
        const bioExpr = args.bio !== undefined ? shQuote(args.bio) : 'p.bio';
        const sql = `
UPDATE profiles p
SET full_name = ${fullNameExpr},
    bio = ${bioExpr},
    updated_at = NOW()
WHERE p.user_id = (SELECT id FROM users WHERE email = ${shQuote(args.email)});
`;
        const out = await executeDbSql(args.database, sql, args.dbUser, args.dbPassword);
        return toTextResult(`Profile updated for ${args.email}.\n${out || '(no output)'}`);
      }

      case 'db_delete_user_with_profile_prepare': {
        requireConnected();
        const args = z
          .object({
            database: z.string(),
            dbUser: z.string().optional(),
            dbPassword: z.string().optional(),
            email: z.string().email(),
          })
          .parse(request.params.arguments);

        const sql = `DELETE FROM users WHERE email = ${shQuote(args.email)};`;
        const cmd = `${args.dbPassword ? `PGPASSWORD=${shQuote(args.dbPassword)} ` : ''}psql -At -d ${shQuote(args.database)}${args.dbUser ? ` -U ${shQuote(args.dbUser)}` : ''} -c ${shQuote(sql)}`;
        const op = await persistCreatePendingOp('db_delete_user_with_profile', cmd, `Delete user/profile for ${args.email} in postgres/${args.database}`);
        return toJsonResult({
          ok: true,
          op_id: op.id,
          kind: op.kind,
          summary: op.summary,
          expires_in_seconds: Math.floor((op.expiresAt - Date.now()) / 1000),
        });
      }

      case 'db_delete_user_with_profile_confirm': {
        requireConnected();
        const args = z.object({ op_id: z.string() }).parse(request.params.arguments);
        const op = getPendingOp(args.op_id, 'db_delete_user_with_profile');
        const out = await runCommandOrThrow(op.command, op.summary);
        await persistConsumePendingOp(op.id);
        return toJsonResult({ ok: true, summary: op.summary, output: out || '' });
      }

      case 'cloudflare_tunnel_status': {
        requireConnected();
        const args = z.object({ serviceName: z.string().default('cloudflared') }).parse(request.params.arguments);
        const cmd = `systemctl is-active ${shQuote(args.serviceName)} || true; echo '---'; systemctl status ${shQuote(args.serviceName)} --no-pager -l || true; echo '---'; pgrep -af cloudflared || true`;
        const out = await runCommand(cmd);
        return toTextResult(`STDOUT:\n${out.stdout}\n\nSTDERR:\n${out.stderr}\n\nExit Code: ${out.code}`);
      }

      case 'cloudflare_tunnel_logs': {
        requireConnected();
        const args = z
          .object({
            serviceName: z.string().default('cloudflared'),
            lines: z.number().int().min(1).max(1000).default(100),
          })
          .parse(request.params.arguments);
        const out = await runCommandOrThrow(`journalctl -u ${shQuote(args.serviceName)} -n ${args.lines} --no-pager`, 'Read cloudflared logs');
        return toJsonResult({ ok: true, service: args.serviceName, lines: args.lines, logs: out || '' });
      }

      case 'cloudflare_tunnel_config_test': {
        requireConnected();
        const args = z.object({ configPath: z.string().default('/etc/cloudflared/config.yml') }).parse(request.params.arguments);
        const out = await runCommandOrThrow(`cloudflared tunnel ingress validate --config ${shQuote(args.configPath)}`, 'Validate cloudflared config');
        return toJsonResult({ ok: true, config_path: args.configPath, output: out || 'Config validation passed' });
      }

      case 'cloudflare_tunnel_restart_prepare': {
        requireConnected();
        const args = z.object({ serviceName: z.string().default('cloudflared') }).parse(request.params.arguments);
        const cmd = `sudo systemctl restart ${shQuote(args.serviceName)} && systemctl is-active ${shQuote(args.serviceName)}`;
        const op = await persistCreatePendingOp('cloudflare_tunnel_restart', cmd, `Restart service ${args.serviceName}`);
        return toJsonResult({
          ok: true,
          op_id: op.id,
          kind: op.kind,
          summary: op.summary,
          expires_in_seconds: Math.floor((op.expiresAt - Date.now()) / 1000),
        });
      }

      case 'cloudflare_tunnel_restart_confirm': {
        requireConnected();
        const args = z.object({ op_id: z.string() }).parse(request.params.arguments);
        const op = getPendingOp(args.op_id, 'cloudflare_tunnel_restart');
        const out = await runCommandOrThrow(op.command, op.summary);
        await persistConsumePendingOp(op.id);
        return toJsonResult({ ok: true, summary: op.summary, output: out || '' });
      }

      case 'cloudflare_tunnel_route_dns': {
        requireConnected();
        const args = z
          .object({
            tunnel: z.string(),
            hostname: z.string(),
            overwrite: z.boolean().default(false),
          })
          .parse(request.params.arguments);

        const overwriteFlag = args.overwrite ? ' --overwrite-dns' : '';
        const out = await runCommandOrThrow(
          `cloudflared tunnel route dns${overwriteFlag} ${shQuote(args.tunnel)} ${shQuote(args.hostname)}`,
          'Route tunnel DNS'
        );
        return toJsonResult({
          ok: true,
          tunnel: args.tunnel,
          hostname: args.hostname,
          overwrite: args.overwrite,
          output: out || 'DNS route updated',
        });
      }

      case 'ports_inventory': {
        requireConnected();
        const cmd = `
echo '=== LISTENERS ===';
(ss -tulpen || netstat -tulpen) 2>/dev/null || true;
echo '=== UFW ===';
(ufw status numbered || true);
echo '=== IPTABLES ===';
(iptables -S INPUT || true);
echo '=== NFTABLES ===';
(nft list ruleset || true);
echo '=== DOCKER PORTS ===';
(docker ps --format 'table {{.Names}}\t{{.Ports}}' || true);
`;
        const out = await runCommand(cmd);
        return toTextResult(`STDOUT:\n${out.stdout}\n\nSTDERR:\n${out.stderr}\n\nExit Code: ${out.code}`);
      }

      case 'ports_open_prepare': {
        requireConnected();
        const args = z.object({ port: z.number().int().min(1).max(65535), protocol: z.enum(['tcp', 'udp']).default('tcp') }).parse(request.params.arguments);
        const cmd = `sudo ufw allow ${args.port}/${args.protocol}`;
        const op = await persistCreatePendingOp('ports_open', cmd, `Open ${args.protocol.toUpperCase()} port ${args.port} in UFW`);
        return toJsonResult({
          ok: true,
          op_id: op.id,
          kind: op.kind,
          summary: op.summary,
          expires_in_seconds: Math.floor((op.expiresAt - Date.now()) / 1000),
        });
      }

      case 'ports_open_confirm': {
        requireConnected();
        const args = z.object({ op_id: z.string() }).parse(request.params.arguments);
        const op = getPendingOp(args.op_id, 'ports_open');
        const out = await runCommandOrThrow(op.command, op.summary);
        await persistConsumePendingOp(op.id);
        return toJsonResult({ ok: true, summary: op.summary, output: out || '' });
      }

      case 'ports_close_prepare': {
        requireConnected();
        const args = z.object({ port: z.number().int().min(1).max(65535), protocol: z.enum(['tcp', 'udp']).default('tcp') }).parse(request.params.arguments);
        const cmd = `sudo ufw delete allow ${args.port}/${args.protocol}`;
        const op = await persistCreatePendingOp('ports_close', cmd, `Close ${args.protocol.toUpperCase()} port ${args.port} in UFW`);
        return toJsonResult({
          ok: true,
          op_id: op.id,
          kind: op.kind,
          summary: op.summary,
          expires_in_seconds: Math.floor((op.expiresAt - Date.now()) / 1000),
        });
      }

      case 'ports_close_confirm': {
        requireConnected();
        const args = z.object({ op_id: z.string() }).parse(request.params.arguments);
        const op = getPendingOp(args.op_id, 'ports_close');
        const out = await runCommandOrThrow(op.command, op.summary);
        await persistConsumePendingOp(op.id);
        return toJsonResult({ ok: true, summary: op.summary, output: out || '' });
      }

      case 'ports_kill_process_prepare': {
        requireConnected();
        const args = z.object({ port: z.number().int().min(1).max(65535), force: z.boolean().default(false) }).parse(request.params.arguments);
        const signal = args.force ? '-9' : '-15';
        const cmd = `PIDS=$(ss -ltnpH 'sport = :${args.port}' | sed -n 's/.*pid=\\([0-9]\\+\\).*/\\1/p' | sort -u); if [ -z "$PIDS" ]; then echo 'No process found on port ${args.port}'; exit 1; fi; kill ${signal} $PIDS; echo "Killed PIDs: $PIDS"`;
        const op = await persistCreatePendingOp('ports_kill_process', cmd, `Kill process(es) on TCP port ${args.port} with signal ${signal}`);
        return toJsonResult({
          ok: true,
          op_id: op.id,
          kind: op.kind,
          summary: op.summary,
          expires_in_seconds: Math.floor((op.expiresAt - Date.now()) / 1000),
        });
      }

      case 'ports_kill_process_confirm': {
        requireConnected();
        const args = z.object({ op_id: z.string() }).parse(request.params.arguments);
        const op = getPendingOp(args.op_id, 'ports_kill_process');
        const out = await runCommandOrThrow(op.command, op.summary);
        await persistConsumePendingOp(op.id);
        return toJsonResult({ ok: true, summary: op.summary, output: out || '' });
      }

      case 'ports_reconcile': {
        requireConnected();
        const cmd = `
echo 'Listeners:';
ss -ltnH | awk '{print $4}' | sed 's/.*://' | sort -n | uniq;
echo '---';
echo 'UFW allow rules:';
ufw status numbered | sed -n 's/.*\\([0-9]\\+\\)\/\(tcp\|udp\).*/\\1\/\\2/p' | sort -u || true;
`;
        const out = await runCommand(cmd);
        return toJsonResult({ ok: out.code === 0, stdout: out.stdout, stderr: out.stderr, exit_code: out.code });
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      const message = (error as Error).message;
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${message}`);
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return toTextResult(`Error: ${message}`, true);
  }
});

async function run() {
  await loadPendingOps();

  const transportMode = process.env.MCP_TRANSPORT || 'stdio';
  if (transportMode === 'http') {
    const host = process.env.MCP_HOST || '0.0.0.0';
    const port = Number(process.env.MCP_PORT || '59450');
    const path = '/mcp';

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);

    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        if (url.pathname !== path) {
          if (url.pathname === '/health') {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, transport: 'http' }));
            return;
          }
          res.statusCode = 404;
          res.end('Not Found');
          return;
        }

        if (req.method && !['GET', 'POST', 'DELETE'].includes(req.method)) {
          res.statusCode = 405;
          res.end('Method Not Allowed');
          return;
        }

        let parsedBody: unknown = undefined;
        if (req.method === 'POST' || req.method === 'DELETE') {
          const MAX_BODY = 1024 * 1024;
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += piece.length;
            if (size > MAX_BODY) {
              res.statusCode = 413;
              res.end('Payload Too Large');
              return;
            }
            chunks.push(piece);
          }
          const body = Buffer.concat(chunks).toString('utf8');
          if (body.trim().length > 0) {
            try {
              parsedBody = JSON.parse(body);
            } catch {
              res.statusCode = 400;
              res.end('Invalid JSON');
              return;
            }
          }
        }

        await transport.handleRequest(req, res, parsedBody);
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'internal error' }));
      }
    });

    httpServer.listen(port, host, () => {
      console.error(`VPS MCP Server running on http://${host}:${port}${path}`);
    });
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('VPS MCP Server running on stdio');
}

run().catch((error: unknown) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});

/**
 * Phase 0 POC: Hook Server
 *
 * This server receives hook requests from Claude Code and allows
 * manual approval/denial via stdin or automatic responses.
 *
 * Usage:
 *   npm run poc:server
 *
 * Then trigger a Claude Code action that requires permission.
 * The hook will POST to this server, and you can approve/deny.
 */

import Fastify from 'fastify';
import * as readline from 'readline';

const PORT = 3847;

// Store pending approval requests
interface PendingRequest {
  id: string;
  type: 'permission' | 'pretool';
  payload: unknown;
  timestamp: Date;
  resolve: (decision: HookResponse) => void;
}

interface HookResponse {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
}

const pendingRequests = new Map<string, PendingRequest>();
let requestCounter = 0;

// Create Fastify instance
const app = Fastify({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  },
});

// Health check endpoint
app.get('/health', async () => {
  return { status: 'ok', pending: pendingRequests.size };
});

// Permission request hook endpoint
app.post('/hook/permission', async (request, reply) => {
  const id = `perm-${++requestCounter}`;
  const payload = request.body;

  console.log('\n' + '='.repeat(60));
  console.log(`[${id}] PERMISSION REQUEST RECEIVED`);
  console.log('='.repeat(60));
  console.log(JSON.stringify(payload, null, 2));
  console.log('='.repeat(60));
  console.log(`Type 'allow ${id}' or 'deny ${id}' to respond`);
  console.log('Or just type "allow" or "deny" for the most recent request');

  // Create a promise that will be resolved when user responds
  const decision = await new Promise<HookResponse>((resolve) => {
    pendingRequests.set(id, {
      id,
      type: 'permission',
      payload,
      timestamp: new Date(),
      resolve,
    });
  });

  pendingRequests.delete(id);
  console.log(`[${id}] Responded with: ${decision.decision}`);

  // Return the decision in the format Claude Code expects
  return decision;
});

// PreToolUse hook endpoint
app.post('/hook/pretool', async (request, reply) => {
  const id = `tool-${++requestCounter}`;
  const payload = request.body;

  console.log('\n' + '='.repeat(60));
  console.log(`[${id}] PRE-TOOL-USE REQUEST`);
  console.log('='.repeat(60));
  console.log(JSON.stringify(payload, null, 2));
  console.log('='.repeat(60));
  console.log(`Type 'allow ${id}' or 'deny ${id}' to respond`);

  const decision = await new Promise<HookResponse>((resolve) => {
    pendingRequests.set(id, {
      id,
      type: 'pretool',
      payload,
      timestamp: new Date(),
      resolve,
    });
  });

  pendingRequests.delete(id);
  console.log(`[${id}] Responded with: ${decision.decision}`);

  return decision;
});

// Setup readline for interactive input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function processCommand(line: string) {
  const parts = line.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const targetId = parts[1];

  if (!command) return;

  if (command === 'list' || command === 'ls') {
    if (pendingRequests.size === 0) {
      console.log('No pending requests');
    } else {
      console.log('Pending requests:');
      for (const [id, req] of pendingRequests) {
        console.log(`  ${id} (${req.type}) - ${req.timestamp.toISOString()}`);
      }
    }
    return;
  }

  if (command === 'allow' || command === 'deny') {
    let request: PendingRequest | undefined;

    if (targetId) {
      request = pendingRequests.get(targetId);
    } else {
      // Get most recent request
      const entries = Array.from(pendingRequests.values());
      request = entries[entries.length - 1];
    }

    if (!request) {
      console.log('No matching pending request found');
      return;
    }

    const decision: HookResponse = {
      decision: command as 'allow' | 'deny',
      reason: parts.slice(2).join(' ') || undefined,
    };

    request.resolve(decision);
    return;
  }

  if (command === 'help') {
    console.log(`
Commands:
  allow [id] [reason]  - Allow the request (most recent if no id)
  deny [id] [reason]   - Deny the request (most recent if no id)
  list / ls            - List pending requests
  help                 - Show this help
  quit / exit          - Stop the server
    `);
    return;
  }

  if (command === 'quit' || command === 'exit') {
    console.log('Shutting down...');
    process.exit(0);
  }

  console.log(`Unknown command: ${command}. Type 'help' for commands.`);
}

rl.on('line', processCommand);

// Start the server
async function start() {
  try {
    await app.listen({ port: PORT, host: '127.0.0.1' });
    console.log(`
╔════════════════════════════════════════════════════════════╗
║           ClaudeBridge POC Hook Server                     ║
╠════════════════════════════════════════════════════════════╣
║  Listening on: http://127.0.0.1:${PORT}                       ║
║                                                            ║
║  Endpoints:                                                ║
║    POST /hook/permission  - Permission request hook        ║
║    POST /hook/pretool     - Pre-tool-use hook              ║
║    GET  /health           - Health check                   ║
║                                                            ║
║  Commands: allow, deny, list, help, quit                   ║
╚════════════════════════════════════════════════════════════╝
`);
    console.log('Waiting for hook requests...\n');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();

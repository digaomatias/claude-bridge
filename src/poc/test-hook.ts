/**
 * Phase 0 POC: Test Hook
 *
 * This script simulates what Claude Code's hook would send to our server.
 * Use this to test the hook server without needing Claude Code running.
 *
 * Usage:
 *   npm run poc:test
 */

const PORT = 3847;
const BASE_URL = `http://127.0.0.1:${PORT}`;

interface HookPayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  permission_type?: string;
  message?: string;
}

async function sendHookRequest(
  endpoint: string,
  payload: HookPayload
): Promise<unknown> {
  console.log(`\nSending ${endpoint} request...`);
  console.log('Payload:', JSON.stringify(payload, null, 2));

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  console.log('Response:', JSON.stringify(result, null, 2));
  return result;
}

async function testPermissionHook() {
  // Simulate a permission request like Claude Code would send
  const payload: HookPayload = {
    permission_type: 'Bash',
    message: 'Claude wants to run: npm install express',
    tool_name: 'Bash',
    tool_input: {
      command: 'npm install express',
      description: 'Install express package',
    },
  };

  return sendHookRequest('/hook/permission', payload);
}

async function testPreToolHook() {
  // Simulate a pre-tool-use hook
  const payload: HookPayload = {
    tool_name: 'Edit',
    tool_input: {
      file_path: '/Users/test/project/src/index.ts',
      old_string: 'const x = 1;',
      new_string: 'const x = 2;',
    },
  };

  return sendHookRequest('/hook/pretool', payload);
}

async function healthCheck() {
  try {
    const response = await fetch(`${BASE_URL}/health`);
    const result = await response.json();
    console.log('Health check:', result);
    return true;
  } catch {
    console.log('Server not responding. Start it with: npm run poc:server');
    return false;
  }
}

async function main() {
  console.log('ClaudeBridge POC Hook Test\n');

  // Check if server is running
  if (!(await healthCheck())) {
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const testType = args[0] || 'permission';

  if (testType === 'permission') {
    await testPermissionHook();
  } else if (testType === 'pretool') {
    await testPreToolHook();
  } else {
    console.log('Usage: npm run poc:test [permission|pretool]');
  }
}

main().catch(console.error);

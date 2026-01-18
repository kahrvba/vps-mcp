import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  console.log('Starting integration test...');

  const transport = new StdioClientTransport({
    command: 'sh',
    args: ['-c', 'cd /tmp && npx -y vps-mcp@1.0.2'],
  });

  const client = new Client(
    {
      name: 'test-client',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  try {
    console.log('Connecting to server via npx...');
    await client.connect(transport);
    console.log('Connected!');

    console.log('Listing tools...');
    const result = await client.listTools();
    
    console.log('Tools found:');
    result.tools.forEach(tool => {
        console.log(`- ${tool.name}: ${tool.description}`);
    });

    const expectedTools = ['connect_vps', 'disconnect_vps', 'execute_command', 'list_directory', 'create_directory', 'read_file', 'write_file', 'delete_item', 'change_directory', 'get_current_directory'];
    
    const foundToolNames = result.tools.map(t => t.name);
    const missingTools = expectedTools.filter(t => !foundToolNames.includes(t));

    if (missingTools.length === 0) {
        console.log('\nSUCCESS: All expected tools are present.');
    } else {
        console.error('\nFAILURE: Missing tools:', missingTools);
        process.exit(1);
    }

  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();

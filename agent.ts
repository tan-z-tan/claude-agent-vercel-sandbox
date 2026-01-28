import ms from 'ms';
import { Sandbox } from '@vercel/sandbox';
import Anthropic from '@anthropic-ai/sdk';

async function main() {
  const prompt = process.argv[2];
  if (!prompt) {
    console.error('Please provide a prompt as an argument.');
    process.exit(1);
  }

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  console.log('Creating Sandbox...');
  const sandbox = await Sandbox.create({
    resources: { vcpus: 2 },
    timeout: ms('10m'), // Longer timeout for autonomous tasks
    runtime: 'node22',
  });
  console.log(`Sandbox created: ${sandbox.sandboxId}`);

  try {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: prompt }
    ];

    const tools: Anthropic.Tool[] = [
      {
        type: 'web_fetch_20250910',
        name: 'web_fetch',
      } as any,
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 5,
        user_location: {
          type: "approximate",
          city: "Tokyo",
          region: "Tokyo",
          country: "JP",
          timezone: "Asia/Tokyo"
        }
      } as any,
      {
        name: 'run_command',
        description: 'Run a shell command in the sandbox.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command to run.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the command.' },
          },
          required: ['command'],
        },
      },
      {
        name: 'write_file',
        description: 'Write a file to the sandbox.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The absolute path to the file.' },
            content: { type: 'string', description: 'The content of the file.' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'read_file',
        description: 'Read a file from the sandbox.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The absolute path to the file.' },
          },
          required: ['path'],
        },
      },
      {
        name: 'list_files',
        description: 'List files in a directory in the sandbox.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The directory path.' },
          },
          required: ['path'],
        },
      },
    ];

    let running = true;
    while (running) {
      console.log('\n--- Claude is thinking ---');
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 4096,
        messages,
        tools,
      }, {
        headers: {
          'anthropic-beta': 'web-search-2025-03-05,web-fetch-2025-09-10',
        },
      });

      const content = response.content;
      messages.push({ role: 'assistant', content });

      let toolCallsFound = false;
      for (const block of content) {
        if (block.type === 'text') {
          process.stdout.write(block.text);
        } else if (block.type === 'tool_use') {
          toolCallsFound = true;
          const toolUse = block;
          console.log(`\n[Tool Use: ${toolUse.name}]`, toolUse.input);

          let result: any;
          try {
            switch (toolUse.name) {
              case 'run_command': {
                const { command, args = [] } = toolUse.input as any;
                const res = await sandbox.runCommand({ cmd: command, args });
                // Serialize stdout and stderr correctly by calling them if they are functions, 
                // or taking them as strings if they've already been captured.
                const stdout = typeof res.stdout === 'function' ? await (res as any).stdout() : res.stdout;
                const stderr = typeof res.stderr === 'function' ? await (res as any).stderr() : res.stderr;
                result = { exitCode: res.exitCode, stdout, stderr };
                break;
              }
              case 'write_file': {
                const { path, content } = toolUse.input as any;
                await sandbox.writeFiles([{ path, content: Buffer.from(content) }]);
                result = { status: 'success' };
                break;
              }
              case 'read_file': {
                const { path } = toolUse.input as any;
                const buffer = await sandbox.readFileToBuffer({ path });
                result = { content: buffer?.toString() || 'File not found' };
                break;
              }
              case 'list_files': {
                const { path } = toolUse.input as any;
                const res = await sandbox.runCommand({ cmd: 'ls', args: ['-R', path] });
                const stdout = typeof res.stdout === 'function' ? await (res as any).stdout() : res.stdout;
                const stderr = typeof res.stderr === 'function' ? await (res as any).stderr() : res.stderr;
                result = { stdout, stderr };
                break;
              }
              default:
                result = { error: 'Unknown tool' };
            }
          } catch (error: any) {
            result = { error: error.message };
          }

          console.log(`[Tool Result: ${toolUse.name}]`, result);
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify(result),
              },
            ],
          });
        }
      }

      if (!toolCallsFound) {
        running = false;
      }
    }
    console.log('\n--- Task Completed ---');
  } finally {
    await sandbox.stop();
    console.log('Sandbox stopped.');
  }
}

main().catch(async (error) => {
  console.error('Fatal Error:', error);
  process.exit(1);
});

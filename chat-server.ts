import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import express from 'express';
import { Sandbox } from '@vercel/sandbox';
import { ToolLoopAgent, pipeAgentUIStreamToResponse, tool, zodSchema } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('⚠️ Warning: ANTHROPIC_API_KEY is not set in .env.local');
}

// Serve the static HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'external_client.html'));
});

// Implementation of the Host API
app.post('/api/chat', async (req, res) => {
  console.log('[Server] Request Body:', JSON.stringify(req.body));
  let { messages, sandboxId: existingId } = req.body;

  if (!messages) {
    return res.status(400).json({ error: 'messages parameter must be provided' });
  }

  // Convert simple message format to UIMessage format if needed
  messages = messages.map((m: any, i: number) => {
    if (!m.parts && m.text) {
      return {
        id: m.id || `msg-${i}-${Date.now()}`,
        role: m.role,
        parts: [{ type: 'text', text: m.text }]
      };
    }
    return m;
  });

  let sandbox: Sandbox | undefined;

  try {
    // 1. Initialize or Retrieve Sandbox
    // Use Sandbox.get instead of Sandbox.resume
    sandbox = existingId
      ? await Sandbox.get({ sandboxId: existingId })
      : await Sandbox.create({
        runtime: 'node22',
        timeout: 1000 * 60 * 10
      });

    console.log(`[Server] Sandbox: ${sandbox.sandboxId} (${existingId ? 'Retrieved' : 'Created'})`);

    // 2. Define Agent with full toolset from agent.ts (matching snake_case names)
    const agent = new ToolLoopAgent({
      model: anthropic('claude-sonnet-4-5'),
      headers: {
        'anthropic-beta': 'web-search-2025-03-05,web-fetch-2025-09-10',
      },
      tools: {
        web_search: anthropic.tools.webSearch_20250305({
          maxUses: 5,
          userLocation: {
            type: "approximate",
            city: "Tokyo",
            region: "Tokyo",
            country: "JP",
            timezone: "Asia/Tokyo"
          }
        }),
        web_fetch: anthropic.tools.webFetch_20250910(),
        run_command: tool({
          description: 'Run a shell command in the sandbox',
          inputSchema: zodSchema(z.object({
            command: z.string().describe('The command to run'),
            args: z.array(z.string()).optional().describe('Arguments for the command')
          })),
          execute: async ({ command, args = [] }) => {
            console.log(`[Agent] Executing: ${command} ${args.join(' ')}`);
            const r = await sandbox!.runCommand({ cmd: command, args });
            return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
          },
        }),
        write_file: tool({
          description: 'Write a file to the sandbox',
          inputSchema: zodSchema(z.object({
            path: z.string().describe('Absolute path to the file'),
            content: z.string().describe('Content of the file')
          })),
          execute: async ({ path, content }) => {
            console.log(`[Agent] Writing file: ${path}`);
            await sandbox!.writeFiles([{ path, content: Buffer.from(content) }]);
            return { status: 'success' };
          },
        }),
        read_file: tool({
          description: 'Read a file from the sandbox',
          inputSchema: zodSchema(z.object({
            path: z.string().describe('Absolute path to the file')
          })),
          execute: async ({ path }) => {
            console.log(`[Agent] Reading file: ${path}`);
            const buffer = await sandbox!.readFileToBuffer({ path });
            return { content: buffer?.toString() || 'File not found' };
          },
        }),
        list_files: tool({
          description: 'List files in a directory in the sandbox',
          inputSchema: zodSchema(z.object({
            path: z.string().describe('Directory path')
          })),
          execute: async ({ path }) => {
            console.log(`[Agent] Listing files in: ${path}`);
            const r = await sandbox!.runCommand({ cmd: 'ls', args: ['-R', path] });
            return { stdout: r.stdout, stderr: r.stderr };
          },
        }),
      },
    });

    // 3. Pipe Agent stream to Express response
    await pipeAgentUIStreamToResponse({
      response: res,
      agent,
      uiMessages: messages,
      headers: {
        'x-sandbox-id': sandbox.sandboxId,
      }
    });

  } catch (error: any) {
    console.error('[Error]', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  } finally {
    // If we stop the sandbox here, it cannot be resumed in the next request.
    // However, the user explicitly asked for sandbox.stop() on completion/error.
    if (sandbox) {
      console.log(`[Server] Stopping Sandbox: ${sandbox.sandboxId}`);
      await sandbox.stop();
    }
  }
});

app.listen(port, () => {
  console.log(`\n🚀 Demo server running at http://localhost:${port}`);
});

// Minimal stdio MCP server for cli/tests/mcp-client.test.mjs. Low-level
// `Server` with raw JSON schemas, so it does not depend on the SDK's zod peer.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fake-mcp', version: '0.0.1' }, { capabilities: { tools: {} } });

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the text back.\nSecond line of description.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'What to echo' } },
      required: ['text'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'env-probe',
    description: 'Report whether PUSH_MCP_TEST_SECRET reached this process.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fail',
    description: 'Always reports a tool error.',
    inputSchema: { type: 'object', properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  switch (name) {
    case 'echo':
      return { content: [{ type: 'text', text: `echo: ${args.text}` }] };
    case 'env-probe':
      return {
        content: [
          {
            type: 'text',
            text: `secret=${process.env.PUSH_MCP_TEST_SECRET ?? '(unset)'} extra=${process.env.FAKE_EXTRA ?? '(unset)'}`,
          },
        ],
      };
    case 'fail':
      return { isError: true, content: [{ type: 'text', text: 'boom' }] };
    default:
      return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
  }
});

await server.connect(new StdioServerTransport());

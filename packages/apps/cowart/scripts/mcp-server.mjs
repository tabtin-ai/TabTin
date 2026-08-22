#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const protocolVersion = '2025-06-18';

const tools = [
  {
    name: 'mcp_cowart_read_canvas_state',
    description: 'Read the minimal Cowart canvas state from the current Space working directory.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'mcp_cowart_insert_shape',
    description: 'Insert a simple non-image shape into the minimal Cowart canvas state.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['note', 'rect'],
          description: 'Shape type to insert. Defaults to note.',
        },
        text: {
          type: 'string',
          description: 'Optional text for a note shape.',
        },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
];

let buffer = '';

function projectDir() {
  const dir = process.env.COWART_PROJECT_DIR;
  if (!dir || !dir.trim()) {
    throw new Error('COWART_PROJECT_DIR is required');
  }
  return path.resolve(dir);
}

function canvasStatePath() {
  return path.join(projectDir(), '.cowart', 'canvas-state.json');
}

function defaultState() {
  return {
    version: 1,
    pluginInstallPath: process.env.TABTIN_PLUGIN_INSTALL_PATH,
    elements: [],
  };
}

async function readState() {
  try {
    return JSON.parse(await readFile(canvasStatePath(), 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return defaultState();
    throw err;
  }
}

async function writeState(state) {
  const target = canvasStatePath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function textResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

async function callTool(name, args) {
  if (name === 'mcp_cowart_read_canvas_state') {
    const state = await readState();
    return textResult({
      ok: true,
      state,
      projectDir: projectDir(),
      pluginInstallPath: process.env.TABTIN_PLUGIN_INSTALL_PATH,
    });
  }

  if (name === 'mcp_cowart_insert_shape') {
    const state = await readState();
    const elements = Array.isArray(state.elements) ? state.elements : [];
    const element = {
      id: `cowart-shape-${Date.now()}`,
      type: args?.type === 'rect' ? 'rect' : 'note',
      text: typeof args?.text === 'string' ? args.text : '',
      x: typeof args?.x === 'number' ? args.x : 0,
      y: typeof args?.y === 'number' ? args.y : 0,
    };
    const next = { ...state, version: 1, elements: [...elements, element] };
    await writeState(next);
    return textResult({ ok: true, element, state: next });
  }

  throw new Error(`Unknown Cowart MCP tool: ${name}`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;

  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'tabtin-cowart-mcp', version: '0.1.2' },
      instructions: 'Cowart MCP exposes non-image canvas state tools scoped to this runtime session.',
    });
    return;
  }

  if (message.method === 'notifications/initialized') return;

  if (message.method === 'tools/list') {
    result(message.id, { tools });
    return;
  }

  if (message.method === 'tools/call') {
    try {
      result(message.id, await callTool(message.params?.name, message.params?.arguments ?? {}));
    } catch (err) {
      error(message.id, -32000, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (message.id !== undefined) {
    error(message.id, -32601, `Unsupported method: ${message.method}`);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      void handle(JSON.parse(line)).catch((err) => error(null, -32603, err.message));
    }
    newline = buffer.indexOf('\n');
  }
});

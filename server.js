const express = require('express');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;
const OAUTH_PORT = parseInt(process.env.OAUTH_PORT || '8081', 10);
const PUBLIC_HOSTNAME = process.env.PUBLIC_HOSTNAME; // ex: my-bridge.fly.dev
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN; // shared secret pour Make

if (!PUBLIC_HOSTNAME) {
  console.error('Missing PUBLIC_HOSTNAME env var (ex: my-app.fly.dev)');
  process.exit(1);
}
if (!BRIDGE_TOKEN) {
  console.error('Missing BRIDGE_TOKEN env var (strong random secret)');
  process.exit(1);
}

// Lance mcp-remote (proxy OAuth + client remote) vers Notion MCP
const mcp = spawn(
  'npx',
  [
    '-y',
    'mcp-remote',
    'https://mcp.notion.com/mcp',
    String(OAUTH_PORT),
    '--host',
    PUBLIC_HOSTNAME,
    '--transport',
    'http-first',
    '--debug'
  ],
  {
    env: {
      ...process.env,
      MCP_REMOTE_CONFIG_DIR: '/data/.mcp-auth'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  }
);

// Parser STDIO type LSP: "Content-Length: N\r\n\r\n<json>"
let readBuffer = Buffer.alloc(0);
const pending = new Map(); // id -> {resolve, reject}

function tryParseMessages() {
  while (true) {
    const sep = '\r\n\r\n';
    const idx = readBuffer.indexOf(sep);
    if (idx === -1) break;

    const header = readBuffer.slice(0, idx).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      readBuffer = readBuffer.slice(idx + sep.length);
      continue;
    }
    const len = parseInt(match[1], 10);
    const start = idx + sep.length;
    if (readBuffer.length < start + len) break;

    const jsonBuf = readBuffer.slice(start, start + len);
    readBuffer = readBuffer.slice(start + len);

    try {
      const msg = JSON.parse(jsonBuf.toString('utf8'));
      if (msg.id != null && pending.has(String(msg.id))) {
        const { resolve } = pending.get(String(msg.id));
        pending.delete(String(msg.id));
        resolve(msg);
      } else {
        console.log('MCP notification/extra:', msg);
      }
    } catch (e) {
      console.error('JSON parse error from mcp-remote:', e);
    }
  }
}

mcp.stdout.on('data', (chunk) => {
  readBuffer = Buffer.concat([readBuffer, chunk]);
  tryParseMessages();
});

mcp.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

mcp.on('exit', (code) => {
  console.error('mcp-remote exited with code', code);
  process.exit(1);
});

function writeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, 'utf8');
  mcp.stdin.write(header);
  mcp.stdin.write(json);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

function auth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing bearer token' });
  }
  const token = auth.slice('Bearer '.length);
  if (token !== BRIDGE_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  return next();
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/rpc', auth, async (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'invalid JSON' });
  }
  if (!payload.jsonrpc || payload.jsonrpc !== '2.0') {
    return res.status(400).json({ error: 'jsonrpc must be "2.0"' });
  }
  if (payload.id == null) {
    return res.status(400).json({ error: 'missing id' });
  }

  const idKey = String(payload.id);
  if (pending.has(idKey)) {
    return res.status(409).json({ error: 'duplicate id in flight' });
  }

  const p = new Promise((resolve, reject) => {
    pending.set(idKey, { resolve, reject });
    setTimeout(() => {
      if (pending.has(idKey)) {
        pending.delete(idKey);
        reject(new Error('timeout'));
      }
    }, 250000);
  });

  try {
    writeMessage(payload);
    const response = await p;
    res.json(response);
  } catch (e) {
    res.status(504).json({ error: 'timeout or bridge error', detail: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Bridge listening on :${PORT}`);
  console.log(`OAuth callback expected on https://${PUBLIC_HOSTNAME}:${OAUTH_PORT}/ (handled by mcp-remote)`);
});



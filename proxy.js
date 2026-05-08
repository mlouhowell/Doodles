// Local proxy for Reve API — avoids CORS restrictions in the browser.
// Usage: node proxy.js
// Serves static files on :3131 and the API proxy on :3132.

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const STATIC_PORT = 3131;
const KEYS = JSON.parse(fs.readFileSync(path.join(__dirname, 'keys.json'), 'utf8'));
const PROXY_PORT  = 3132;
const ROOT        = __dirname;

// ── static file server (replaces python -m http.server) ──────────────────────
const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.webp': 'image/webp',
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // Return list of saved generated images
  if (req.method === 'GET' && urlPath === '/api/generated-images') {
    const imgDir = path.join(ROOT, 'images');
    fs.readdir(imgDir, (err, files) => {
      if (err) { res.writeHead(500); res.end('[]'); return; }
      const generated = files.filter(f => f.startsWith('gen-') && f.endsWith('.png'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(generated.map(f => `images/${f}`)));
    });
    return;
  }

  // Save a generated image to disk
  if (req.method === 'POST' && urlPath === '/api/save-image') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400); res.end('bad json'); return; }
      const b64 = payload.image;
      if (!b64) { res.writeHead(400); res.end('image required'); return; }
      const filename = `gen-${Date.now()}.png`;
      fs.writeFile(path.join(ROOT, 'images', filename), Buffer.from(b64, 'base64'), err => {
        if (err) { res.writeHead(500); res.end('write failed'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ filename }));
      });
    });
    return;
  }

  // Route API calls to the generate handler
  if (req.method === 'POST' && urlPath === '/api/generate') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400); res.end(JSON.stringify({ message: 'bad json' })); return; }
      handleGenerate(payload, res).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: err.message }));
      });
    });
    return;
  }

  const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  const ext      = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(STATIC_PORT, () => console.log(`static  → http://localhost:${STATIC_PORT}`));

// ── reve api proxy ────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/generate') {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); }
    catch { res.writeHead(400); res.end(JSON.stringify({ message: 'bad json' })); return; }
    handleGenerate(payload, res).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ message: err.message }));
    });
  });
}).listen(PROXY_PORT, () => console.log(`proxy   → http://localhost:${PROXY_PORT}`));

async function handleGenerate(payload, res) {
    const { subject, aspect_ratio, version } = payload;
    const apiKey       = KEYS.reve;
    const anthropicKey = KEYS.anthropic;

    if (!subject) { respond(400, { message: 'subject required' }); return; }

    function respond(status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(body));
    }

    function httpsPost(hostname, path, headers, body) {
      return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(body);
        const req = https.request({
          hostname, path, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
        }, r => {
          let data = '';
          r.on('data', c => data += c);
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
      });
    }

    // 1. Ask Claude to fill in brief subject details
    let details;
    try {
      const claude = await httpsPost(
        'api.anthropic.com', '/v1/messages',
        { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 60,
          messages: [{
            role: 'user',
            content: `For a simple children's line drawing of "${subject}", give me a brief comma-separated list of 3-4 visual characteristics (body shape, defining features, limbs/appendages). Just the list, nothing else. Example for "dog": "a round body, floppy ears, a small snout, and four stubby legs"`,
          }],
        }
      );
      details = claude.body.content?.[0]?.text?.trim();
      if (!details) throw new Error('empty response from Claude');
    } catch (err) {
      respond(502, { message: `Claude error: ${err.message}` });
      return;
    }

    // 2. Build the full formula prompt
    const prompt = `A simple hand-drawn sketch of a ${subject} with ${details}. Drawn quickly with a single thick black marker line. Single continuous outlines only — one line per edge, no double outlines, no second stroke, no interior detail lines, no texture marks, no crosshatching, no interior marks of any kind. The inside of every shape is left completely white and empty, no color. Lines are thick, slightly wobbly, imperfect and whimsical. Simple and reductive — like a loose doodle scrawled in a notebook. Pure black lines on white background. No color, no fill, no shading, no gradients.`;

    // 3. Send to Reve
    let reve;
    try {
      reve = await httpsPost(
        'api.reve.com', '/v1/image/create',
        { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
        { prompt, aspect_ratio: aspect_ratio || '2:3', version: version || 'latest' }
      );
    } catch (err) {
      respond(502, { message: `Reve error: ${err.message}` });
      return;
    }

    if (reve.status !== 200 || !reve.body.image) {
      res.writeHead(reve.status, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(reve.body));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(reve.body));
}

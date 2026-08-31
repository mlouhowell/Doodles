// Local proxy for the Krea API — avoids CORS restrictions in the browser.
// Usage: node proxy.js
// Serves static files on :3131 and the API proxy on :3132.

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const STATIC_PORT = 3131;
const KEYS = JSON.parse(fs.readFileSync(path.join(__dirname, 'keys.json'), 'utf8'));

// Krea 2 Medium + the doodles LoRA. Keep in sync with api/generate.js.
const KREA_BASE       = 'https://api.krea.ai';
const KREA_MODEL_PATH = '/generate/image/krea/krea-2/medium';
const STYLE_ID        = 'pgozm164j';
const STYLE_STRENGTH  = 0.5;

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS  = 55000;
const PENDING = ['backlogged', 'queued', 'scheduled', 'processing', 'sampling', 'intermediate-complete'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Create a generation job, wait for it, and hand back the image as base64 so the
// browser keeps seeing the same `{ image }` shape the old Reve endpoint returned.
async function generateWithKrea(apiKey, prompt, aspectRatio) {
  const auth = { 'Authorization': `Bearer ${apiKey}` };

  const created = await fetch(`${KREA_BASE}${KREA_MODEL_PATH}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      aspect_ratio: aspectRatio,
      resolution: '1K',
      creativity: 'raw',
      styles: [{ id: STYLE_ID, strength: STYLE_STRENGTH }],
    }),
  });

  const job = await created.json();
  if (!created.ok || !job.job_id) {
    throw new Error(job.error || `create failed (${created.status})`);
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let status = job.status;
  let result;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const polled = await fetch(`${KREA_BASE}/jobs/${job.job_id}`, { headers: auth });
    const state  = await polled.json();
    status = state.status;
    result = state.result;

    if (status === 'completed') break;
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(result?.error || `job ${status}`);
    }
    if (!PENDING.includes(status)) {
      throw new Error(`unexpected job status: ${status}`);
    }
  }

  if (status !== 'completed') throw new Error('timed out waiting for Krea');

  const url = result?.urls?.[0];
  if (!url) throw new Error('job completed without an image');

  const img = await fetch(url);
  if (!img.ok) throw new Error(`could not fetch result image (${img.status})`);

  return Buffer.from(await img.arrayBuffer()).toString('base64');
}

function httpsPostJson(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
    }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error(`JSON parse failed: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}
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

// ── krea api proxy ────────────────────────────────────────────────────────────
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
    const { subject, aspect_ratio } = payload;
    const apiKey       = KEYS.krea;
    const anthropicKey = KEYS.anthropic;

    if (!subject) { respond(400, { message: 'subject required' }); return; }

    function respond(status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(body));
    }

    const httpsPost = httpsPostJson;

    // 1. Ask Claude to moderate the subject and fill in brief subject details
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
            content: `This is for a playful website that turns a word into a simple children's line drawing for a general audience. First decide whether "${subject}" is appropriate to draw — block anything involving weapons, violence, gore, sexual content, hate, or other content unsuitable for children. If it is NOT appropriate, reply with exactly the single word "BLOCKED" and nothing else. If it IS appropriate, reply with a brief comma-separated list of 3-4 visual characteristics (body shape, defining features, limbs/appendages). Just the list, nothing else. Example for "dog": "a round body, floppy ears, a small snout, and four stubby legs"`,
          }],
        }
      );
      details = claude.body.content?.[0]?.text?.trim();
      if (!details) throw new Error('empty response from Claude');
    } catch (err) {
      respond(502, { message: `Claude error: ${err.message}` });
      return;
    }

    // 1b. Honor the moderation decision
    if (/^blocked\b/i.test(details)) {
      respond(200, { content_violation: true });
      return;
    }

    // 2. Build prompt — the LoRA carries the line-art style
    const prompt = `A simple hand-drawn sketch of a ${subject} with ${details}. Thick black marker lines on a plain white background.`;

    // 3. Send to Krea
    let image;
    try {
      image = await generateWithKrea(apiKey, prompt, aspect_ratio || '2:3');
    } catch (err) {
      respond(502, { message: `Krea error: ${err.message}` });
      return;
    }

    respond(200, { image });
}

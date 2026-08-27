const https = require('https');

// Krea 2 Medium + the doodles LoRA. Style id comes from /styles on the Krea API.
const KREA_BASE       = 'https://api.krea.ai';
const KREA_MODEL_PATH = '/generate/image/krea/krea-2/medium';
const STYLE_ID        = 'pgozm164j';
const STYLE_STRENGTH  = 0.8;

// Krea is a job queue, not a synchronous call — create, then poll until it lands.
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS  = 55000;
const PENDING = ['backlogged', 'queued', 'scheduled', 'processing', 'sampling', 'intermediate-complete'];

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Create a generation job, wait for it, and hand back the finished image as base64
// so callers see the same `{ image }` shape the old Reve endpoint returned.
async function generateWithKrea(apiKey, prompt, aspectRatio) {
  const auth = { 'Authorization': `Bearer ${apiKey}` };

  const created = await fetch(`${KREA_BASE}${KREA_MODEL_PATH}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      aspect_ratio: aspectRatio,
      resolution: '1K',
      creativity: 'raw',                                     // don't let Krea rewrite the prompt
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const { subject, aspect_ratio } = req.body;
  const apiKey       = process.env.KREA_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!subject) { res.status(400).json({ message: 'subject required' }); return; }

  // 1. Ask Claude to moderate the subject and expand it into visual details
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
    res.status(502).json({ message: `Claude error: ${err.message}` });
    return;
  }

  // 1b. Honor the moderation decision
  if (/^blocked\b/i.test(details)) {
    res.status(200).json({ content_violation: true });
    return;
  }

  // 2. Build prompt — the LoRA carries the line-art style, so this only has to
  //    describe the subject.
  const prompt = `A simple hand-drawn sketch of a ${subject} with ${details}. Thick black marker lines on a plain white background.`;

  // 3. Send to Krea
  let image;
  try {
    image = await generateWithKrea(apiKey, prompt, aspect_ratio || '2:3');
  } catch (err) {
    res.status(502).json({ message: `Krea error: ${err.message}` });
    return;
  }

  res.status(200).json({ image });
};

const https = require('https');

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const { subject, aspect_ratio, version } = req.body;
  const apiKey       = process.env.REVE_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!subject) { res.status(400).json({ message: 'subject required' }); return; }

  // 1. Ask Claude to expand subject into visual details
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
    res.status(502).json({ message: `Claude error: ${err.message}` });
    return;
  }

  // 2. Build prompt
  const prompt = `Pure flat white (#FFFFFF) background, no texture, no grain, no grey, no paper texture. A simple hand-drawn sketch of a ${subject} with ${details}. Drawn quickly with a single thick black marker line. Single continuous outlines only — one line per edge, no double outlines, no second stroke, no interior detail lines, no texture marks, no crosshatching, no interior marks of any kind. The inside of every shape is left completely white and empty, no color. Lines are thick, slightly wobbly, imperfect and whimsical. Simple and reductive — like a loose doodle scrawled in a notebook. Pure black lines on pure white background. No color, no fill, no shading, no gradients, no background color.`;

  // 3. Send to Reve
  let reve;
  try {
    reve = await httpsPost(
      'api.reve.com', '/v1/image/create',
      { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      { prompt, aspect_ratio: aspect_ratio || '2:3', version: version || 'latest' }
    );
  } catch (err) {
    res.status(502).json({ message: `Reve error: ${err.message}` });
    return;
  }

  if (reve.status !== 200 || !reve.body.image) {
    res.status(reve.status).json(reve.body);
    return;
  }

  res.status(200).json(reve.body);
};

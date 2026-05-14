const { list, put } = require('@vercel/blob');

async function guessPrompt(imageUrl, anthropicKey) {
  const imgBuf = await fetch(imageUrl).then(r => r.arrayBuffer());
  const b64 = Buffer.from(imgBuf).toString('base64');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 15,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
        { type: 'text', text: 'What is this simple line drawing of? Reply with just the subject in 1-3 words, lowercase, no punctuation.' },
      ]}],
    }),
  });
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).end(); return; }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const storePrefix = process.env.VERCEL_ENV === 'production' ? '' : 'staging/';
  const prefix = `${storePrefix}gen-`;
  const { blobs } = await list({ prefix });

  const pngs = blobs.filter(b => b.pathname.endsWith('.png'));
  const jsonMap = {};
  blobs.filter(b => b.pathname.endsWith('.json')).forEach(b => {
    const base = b.pathname.replace(/\.json$/, '').replace(/^staging\//, '');
    jsonMap[base] = b.url;
  });

  const results = await Promise.all(pngs.map(async b => {
    const base = b.pathname.replace(/\.png$/, '').replace(/^staging\//, '');
    let prompt = null;

    if (jsonMap[base]) {
      try {
        const r = await fetch(jsonMap[base]);
        const data = await r.json();
        prompt = data.prompt || null;
      } catch {}
    }

    if (!prompt && anthropicKey) {
      try {
        prompt = await guessPrompt(b.url, anthropicKey);
        if (prompt) {
          await put(`${storePrefix}${base}.json`, JSON.stringify({ prompt }), {
            access: 'public', contentType: 'application/json',
          });
        }
      } catch {}
    }

    return { url: b.url, prompt };
  }));

  res.status(200).json(results);
};

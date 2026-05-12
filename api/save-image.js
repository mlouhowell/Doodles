const https = require('https');
const { put } = require('@vercel/blob');

function httpsPost(hostname, path, headers, body) {
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  let { image } = req.body;
  if (!image) { res.status(400).json({ message: 'image required' }); return; }

  const apiKey = process.env.REVE_API_KEY;
  let bgRemoved = false;

  try {
    const reve = await httpsPost(
      'api.reve.com', '/v1/image/edit',
      { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      {
        edit_instruction: 'Preserve the line drawing exactly as is. Do not change any lines or shapes.',
        reference_image: image,
        postprocessing: [{ process: 'remove_background' }],
      }
    );
    if (reve.status === 200 && reve.body.image) {
      image = reve.body.image;
      bgRemoved = true;
    } else {
      console.error('Reve bg removal failed:', reve.status, JSON.stringify(reve.body));
    }
  } catch (err) {
    console.error('Reve bg removal error:', err.message);
  }

  const prefix = process.env.VERCEL_ENV === 'production' ? '' : 'staging/';
  const filename = `${prefix}gen-${Date.now()}.png`;
  const buffer = Buffer.from(image, 'base64');
  const blob = await put(filename, buffer, { access: 'public', contentType: 'image/png' });

  res.status(200).json({ url: blob.url, filename, bgRemoved });
};

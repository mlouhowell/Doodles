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
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const { image } = req.body;
  if (!image) { res.status(400).json({ message: 'image required' }); return; }

  const apiKey = process.env.REVE_API_KEY;

  try {
    const reve = await httpsPost(
      'api.reve.com', '/v1/image/edit',
      { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      {
        prompt: 'remove background',
        image,
        postprocessing: [{ process: 'remove_background' }],
      }
    );

    if (reve.status !== 200 || !reve.body.image) {
      res.status(reve.status).json(reve.body);
      return;
    }

    res.status(200).json({ image: reve.body.image });
  } catch (err) {
    res.status(502).json({ message: err.message });
  }
};

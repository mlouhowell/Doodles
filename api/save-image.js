const { put } = require('@vercel/blob');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const { image, prompt } = req.body;
  if (!image) { res.status(400).json({ message: 'image required' }); return; }

  const prefix = process.env.VERCEL_ENV === 'production' ? '' : 'staging/';
  const ts = Date.now();
  const filename = `${prefix}gen-${ts}.png`;
  const buffer = Buffer.from(image, 'base64');
  const blob = await put(filename, buffer, { access: 'public', contentType: 'image/png' });

  if (prompt) {
    await put(`${prefix}gen-${ts}.json`, JSON.stringify({ prompt }), {
      access: 'public',
      contentType: 'application/json',
    });
  }

  res.status(200).json({ url: blob.url, filename });
};

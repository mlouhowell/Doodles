const { put } = require('@vercel/blob');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const { image } = req.body;
  if (!image) { res.status(400).json({ message: 'image required' }); return; }

  const filename = `gen-${Date.now()}.png`;
  const buffer = Buffer.from(image, 'base64');
  const blob = await put(filename, buffer, { access: 'public', contentType: 'image/png' });

  res.status(200).json({ url: blob.url, filename });
};

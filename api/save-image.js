const { PNG } = require('pngjs');
const { put } = require('@vercel/blob');

function removeWhiteBackground(base64) {
  const png = PNG.sync.read(Buffer.from(base64, 'base64'));
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] > 220 && png.data[i + 1] > 220 && png.data[i + 2] > 220) {
      png.data[i + 3] = 0;
    }
  }
  return PNG.sync.write(png).toString('base64');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const { image } = req.body;
  if (!image) { res.status(400).json({ message: 'image required' }); return; }

  const processed = removeWhiteBackground(image);

  const prefix = process.env.VERCEL_ENV === 'production' ? '' : 'staging/';
  const filename = `${prefix}gen-${Date.now()}.png`;
  const buffer = Buffer.from(processed, 'base64');
  const blob = await put(filename, buffer, { access: 'public', contentType: 'image/png' });

  res.status(200).json({ url: blob.url, filename });
};

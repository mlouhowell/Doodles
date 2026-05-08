const { list } = require('@vercel/blob');

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).end(); return; }

  const prefix = process.env.VERCEL_ENV === 'production' ? 'gen-' : 'staging/gen-';
  const { blobs } = await list({ prefix });
  res.status(200).json(blobs.map(b => b.url));
};

const { list } = require('@vercel/blob');

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).end(); return; }

  const { blobs } = await list({ prefix: 'gen-' });
  res.status(200).json(blobs.map(b => b.url));
};

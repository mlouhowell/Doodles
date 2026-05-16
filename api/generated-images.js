const { list } = require('@vercel/blob');

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).end(); return; }

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
    return { url: b.url, prompt };
  }));

  res.status(200).json(results);
};

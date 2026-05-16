const { put } = require('@vercel/blob');

const NOTION_DB = '3b887ba003474e25b46914b8bfe97845';

async function addToNotion(filename, prompt) {
  const key = process.env.NOTION_API_KEY;
  if (!key) return;
  try {
    await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: { database_id: NOTION_DB },
        properties: {
          Prompt: { title: [{ text: { content: prompt } }] },
          'File Name': { rich_text: [{ text: { content: filename } }] },
        },
      }),
    });
  } catch {}
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const { image, prompt } = req.body;
  if (!image) { res.status(400).json({ message: 'image required' }); return; }

  const isProduction = process.env.VERCEL_ENV === 'production';
  const prefix = isProduction ? '' : 'staging/';
  const ts = Date.now();
  const filename = `gen-${ts}.png`;
  const blob = await put(`${prefix}${filename}`, Buffer.from(image, 'base64'), {
    access: 'public', contentType: 'image/png',
  });

  if (prompt) {
    await put(`${prefix}gen-${ts}.json`, JSON.stringify({ prompt }), {
      access: 'public', contentType: 'application/json',
    });
    if (isProduction) addToNotion(filename, prompt);
  }

  res.status(200).json({ url: blob.url, filename });
};

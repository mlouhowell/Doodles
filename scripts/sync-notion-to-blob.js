#!/usr/bin/env node
// One-time script: pulls Notion labels into blob companion JSON files.
// Usage: node scripts/sync-notion-to-blob.js (reads from .env in project root)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { put } = require('@vercel/blob');

const NOTION_DB = '3b887ba003474e25b46914b8bfe97845';
const notionKey = process.env.NOTION_API_KEY;
const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

if (!notionKey || !blobToken) {
  console.error('Missing keys — add NOTION_API_KEY and BLOB_READ_WRITE_TOKEN to .env');
  process.exit(1);
}

(async () => {
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${notionKey}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ page_size: 100 }),
  });

  const data = await res.json();
  const rows = data.results || [];

  // Only process blob images (gen-*.png), not SVG entries
  const blobRows = rows.filter(p => {
    const filename = p.properties['File Name']?.rich_text?.[0]?.text?.content || '';
    return filename.startsWith('gen-') && filename.endsWith('.png');
  });

  console.log(`Found ${blobRows.length} blob image rows in Notion`);

  for (const page of blobRows) {
    const filename = page.properties['File Name']?.rich_text?.[0]?.text?.content;
    const prompt = page.properties['Prompt']?.title?.[0]?.text?.content;
    if (!filename || !prompt) { console.log(`skip (missing data)`); continue; }

    const jsonFilename = filename.replace(/\.png$/, '.json');
    try {
      await put(jsonFilename, JSON.stringify({ prompt }), {
        access: 'public',
        contentType: 'application/json',
        token: blobToken,
      });
      console.log(`✓ ${filename} → "${prompt}"`);
    } catch (e) {
      console.error(`✗ ${filename}:`, e.message);
    }
  }

  console.log('\nDone.');
})();

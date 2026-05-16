#!/usr/bin/env node
// Usage: ANTHROPIC_API_KEY=sk-... node scripts/label-svgs.js
// Converts each SVG to PNG via qlmanage, asks Claude what it is, writes labels.json

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }

const imagesDir = path.join(__dirname, '..', 'images');
const outFile = path.join(__dirname, 'labels.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-labels-'));

const svgs = fs.readdirSync(imagesDir)
  .filter(f => f.endsWith('.svg'))
  .sort((a, b) => {
    const n = s => parseInt(s.match(/\d+/)?.[0] ?? 0);
    return n(a) - n(b);
  });

// Resume from existing labels.json if present
const labels = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};

async function identify(svgFile) {
  const svgPath = path.join(imagesDir, svgFile);
  execSync(`qlmanage -t -s 600 -o "${tmpDir}/" "${svgPath}"`, { stdio: 'ignore' });
  const pngPath = path.join(tmpDir, svgFile + '.png');
  if (!fs.existsSync(pngPath)) throw new Error('No PNG generated for ' + svgFile);
  const b64 = fs.readFileSync(pngPath).toString('base64');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 15,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
        { type: 'text', text: 'What is this simple line drawing of? Reply with just the subject in 1-3 words, lowercase, no punctuation.' },
      ]}],
    }),
  });
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || '?';
}

(async () => {
  for (const svgFile of svgs) {
    if (labels[svgFile]) { console.log(`skip ${svgFile} → ${labels[svgFile]}`); continue; }
    try {
      const label = await identify(svgFile);
      labels[svgFile] = label;
      fs.writeFileSync(outFile, JSON.stringify(labels, null, 2));
      console.log(`${svgFile} → ${label}`);
    } catch (e) {
      console.error(`${svgFile} failed:`, e.message);
      labels[svgFile] = '?';
    }
  }
  console.log('\nDone. Results in scripts/labels.json');
  fs.rmSync(tmpDir, { recursive: true });
})();

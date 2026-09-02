import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const scriptTag = '<script src="/assets/js/public-ticket-pricing.js?v=20260901a" defer></script>';
const files = ['site/index.html', 'site/festival.html'];

for (const relative of files) {
  const file = path.join(root, relative);
  let html = fs.readFileSync(file, 'utf8');
  if (!html.includes(scriptTag)) html = html.replace('</body>', `  ${scriptTag}\n</body>`);
  html = html.replace(/(<meta[^>]+content=")[^"]*\$25[^"]*("[^>]*>)/gi, (match) => match.replaceAll('$25', '$25 through Sept. 1 · $35 beginning Sept. 2'));
  fs.writeFileSync(file, html);
}

console.log('Public ticket-pricing runtime injected.');

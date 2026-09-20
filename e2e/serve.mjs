/** Static server for fixtures/. Content scripts do not run on file:// URLs
 *  unless the user ticks "Allow access to file URLs", which an automated
 *  profile cannot do — so the test page is served over http. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('./fixtures/', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html',
  '.wav': 'audio/wav',
  '.txt': 'text/plain',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

/**
 * `strict.html` is served with the tightest CSP a real site is likely to use.
 * Content scripts are documented as exempt from the host page's CSP for what
 * they inject, but "documented as" is not "verified", and the overlay is
 * unusable if its stylesheet is blocked.
 */
const STRICT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self' blob:; frame-ancestors 'none'";

createServer(async (req, res) => {
  const pathname = normalize(new URL(req.url ?? '/', 'http://x').pathname).replace(/^(\.\.[/\\])+/, '');
  const path = join(ROOT, pathname);
  try {
    const body = await readFile(path);
    const headers = { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' };
    if (pathname.includes('strict')) headers['content-security-policy'] = STRICT_CSP;
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(5311, () => console.log('fixtures on http://localhost:5311'));

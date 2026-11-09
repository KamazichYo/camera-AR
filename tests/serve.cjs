const http = require('http'), fs = require('fs'), path = require('path');
const roots = { '/app/': require('path').resolve(__dirname, '..') + '/', '/t/': __dirname + '/' };
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
module.exports = (port) => new Promise((res) => {
  const srv = http.createServer((q, r) => {
    let u = decodeURIComponent(q.url.split('?')[0]);
    const pre = Object.keys(roots).find((p) => u.startsWith(p));
    if (!pre) { r.writeHead(404); return r.end(); }
    let p = path.join(roots[pre], u.slice(pre.length));
    if (p.endsWith('/')) p += 'index.html';
    fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); r.end(d); });
  }).listen(port, () => res(srv));
});

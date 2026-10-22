// Internal, authenticated CDP gateway. No external npm dependencies.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const auth = JSON.parse(fs.readFileSync(process.env.EASEL_BROWSER_AUTH_FILE, 'utf8'));
if (!/^[a-zA-Z0-9_-]{8,64}$/.test(auth.username) || !/^[a-zA-Z0-9_-]{32,128}$/.test(auth.password)) throw new Error('Invalid browser auth file.');
const expected = Buffer.from('Basic ' + Buffer.from(auth.username + ':' + auth.password).toString('base64'));
const advertised = process.env.EASEL_BROWSER_CDP_HOST || 'easel-test-browser:18801';
if (!/^[a-z0-9.-]+:18801$/.test(advertised)) throw new Error('Invalid advertised CDP host.');
function authorized(req) {
  const actual = Buffer.from(req.headers.authorization || '');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function permitted(path) { return /^\/json(?:\/[^?]*)?(?:\?.*)?$/.test(path) || /^\/devtools\/(browser|page|worker|shared_worker|service_worker)\/[a-zA-Z0-9-]+(?:\?.*)?$/.test(path); }
function upstreamOptions(req) { return {hostname:'127.0.0.1', port:18800, path:req.url, method:req.method, headers:{...req.headers, host:'127.0.0.1:18800', authorization:undefined}}; }
function rewrite(value) {
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'webSocketDebuggerUrl' && typeof item === 'string') value[key] = item.replace(/^ws:\/\/(?:127\.0\.0\.1|localhost):18800\//, 'ws://' + advertised + '/');
      else value[key] = rewrite(item);
    }
  }
  return value;
}
const server = http.createServer((req, res) => {
  if (!authorized(req)) { res.writeHead(401, {'WWW-Authenticate':'Basic realm="Easel CDP"'}); return res.end('Authentication required'); }
  // The browser and application have separate filesystems. Stream only named
  // Chromium downloads over this existing private authenticated connection.
  const download = /^\/easel-downloads\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(req.url);
  if (download) {
    const file = '/tmp/easel-downloads/' + download[1];
    if (req.method === 'DELETE') {
      for (const name of [file, file + '.crdownload']) { try { fs.unlinkSync(name); } catch (error) { if (error.code !== 'ENOENT') { res.writeHead(500); return res.end(); } } }
      res.writeHead(204); return res.end();
    }
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 100 * 1024 * 1024) { fs.closeSync(fd); res.writeHead(413); return res.end(); }
      res.writeHead(200, {'Content-Type':'application/octet-stream', 'Content-Length':stat.size, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
      const stream = fs.createReadStream(file, {fd});
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
    } catch { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } res.writeHead(404); res.end(); }
    return;
  }
  if (!permitted(req.url)) { res.writeHead(404); return res.end(); }
  const options=upstreamOptions(req); delete options.headers.authorization;
  const upstream=http.request(options, response => {
    let bytes=0; const chunks=[];
    response.on('data', chunk => { bytes+=chunk.length; if(bytes>2*1024*1024) { upstream.destroy(); res.destroy(); } else chunks.push(chunk); });
    response.on('end', () => {
      let body=Buffer.concat(chunks);
      if ((response.headers['content-type'] || '').includes('json')) { try { body=Buffer.from(JSON.stringify(rewrite(JSON.parse(body)))); } catch { res.writeHead(502); return res.end('Invalid CDP response'); } }
      const headers={...response.headers, 'content-length':body.length, 'cache-control':'no-store'}; delete headers['transfer-encoding'];
      res.writeHead(response.statusCode,headers); res.end(body);
    });
  });
  upstream.setTimeout(10000,()=>upstream.destroy());
  upstream.on('error',()=>{ if (!res.headersSent) res.writeHead(502); res.end('CDP unavailable'); });
  req.pipe(upstream);
});
server.on('upgrade', (req, socket, head) => {
  if (!authorized(req) || !permitted(req.url)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
  const options=upstreamOptions(req); delete options.headers.authorization;
  const upstream=http.request(options);
  upstream.on('upgrade',(response, peer, peerHead)=>{
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');
    if (head.length) peer.write(head); if(peerHead.length) socket.write(peerHead);
    peer.on('error',()=>socket.destroy()); socket.on('error',()=>peer.destroy()); peer.pipe(socket); socket.pipe(peer);
  });
  upstream.on('response',()=>socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
  upstream.on('error',()=>socket.destroy()); upstream.end();
});
server.headersTimeout=10000; server.requestTimeout=15000;
server.listen(18801,'0.0.0.0');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));


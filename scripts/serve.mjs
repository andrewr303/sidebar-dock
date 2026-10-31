import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('extension');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.avif':'image/avif','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.json':'application/json','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
 try{
  const path=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
  const file=resolve(root, '.'+(path==='/'?'/index.html':path));
  if(file!==root&&!file.startsWith(root+sep)){res.writeHead(403).end();return;}
  if(!(await stat(file)).isFile()){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' http://127.0.0.1:* http://localhost:* https:; font-src 'self'; object-src 'none'; frame-src https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'self'"});
  res.end(await readFile(file));
 }catch(e){res.writeHead(e.code==='ENOENT'?404:500).end('Unable to serve this file');}
});
server.listen(Number(process.env.STILL_PORT||4173),'127.0.0.1',()=>process.stdout.write(`Still preview: http://127.0.0.1:${server.address().port}\n`));

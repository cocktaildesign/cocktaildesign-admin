import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

// Runs before strapi::body: binary uploads cannot spill into the public media library
// or the global multipart temp directory. All unrelated requests pass through.
export default () => async (ctx: any, next: () => Promise<void>) => {
  const prefix = '/api/engraving-files';
  if (ctx.path !== prefix && !ctx.path.startsWith(prefix + '/')) return next();
  ctx.set('Cache-Control', 'no-store');
  ctx.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  ctx.set('Referrer-Policy', 'no-referrer');
  ctx.set('X-Content-Type-Options', 'nosniff');
  const allowedOrigin = ['https://new.cocktaildesign.ru','https://cocktaildesign.ru','https://www.cocktaildesign.ru',
    ...(process.env.NODE_ENV !== 'production' ? ['http://127.0.0.1:3000','http://localhost:3000'] : [])].includes(ctx.get('Origin'));
  // Scoped CORS precedes the global CORS middleware: Authorization cannot use
  // the wildcard allowed-headers response of the existing shop configuration.
  if (allowedOrigin) {
    ctx.set('Access-Control-Allow-Origin', ctx.get('Origin'));
    ctx.set('Vary', 'Origin');
    ctx.set('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
    ctx.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-File-Name, X-File-Size');
  }
  if (ctx.method === 'OPTIONS') { ctx.status = allowedOrigin ? 204 : 403; return; }
  const files = require(path.join(process.cwd(), 'lib/engraving-files.cjs'));
  const token = ctx.get('Authorization').replace(/^Bearer /, '');
  try {
    if (ctx.method === 'GET' && ctx.path === prefix + '/view') {
      // The capability is in the fragment, so it never enters access logs or Referer.
      const script = `const button=document.querySelector('button'),status=document.querySelector('p');
button.onclick=async()=>{button.disabled=true;status.textContent='Загружаем файл…';try{
const parts=location.hash.slice(1).split('.');if(parts.length!==2)throw Error();
const r=await fetch('./download/'+encodeURIComponent(parts[0]),{headers:{Authorization:'Bearer '+parts[1]},cache:'no-store'});
if(r.status===410){status.textContent='Макет перенесён в архив. Обратитесь к менеджеру Cocktail Design.';return;}if(!r.ok)throw Error();
const url=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=url;
const name=r.headers.get('Content-Disposition')?.match(/filename\\*=UTF-8''(.+)/);a.download=name?decodeURIComponent(name[1]):'engraving-file';
a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);status.textContent='Файл скачан.';
}catch{status.textContent='Не удалось скачать макет. Проверьте ссылку или попробуйте позже.';}finally{button.disabled=false;}};`;
      const css = 'body{font:17px/1.6 system-ui,sans-serif;color:#101828;max-width:540px;margin:12vh auto;padding:24px}button{font:inherit;padding:12px 20px;border:0;border-radius:12px;background:#101828;color:white;cursor:pointer}p{color:#667085}';
      const hash = (s: string) => createHash('sha256').update(s).digest('base64');
      ctx.set('Content-Security-Policy', `default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(css)}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
      ctx.type = 'html';
      ctx.body = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Макет гравировки — Cocktail Design</title><style>${css}</style><h1>Макет гравировки</h1><p>Файл клиента к заказу. Ссылка предназначена для получателей заказа.</p><button type="button">Скачать макет</button><script>${script}</script></html>`;
      return;
    }
    const store = files.getStorage();
    if (ctx.method === 'GET' && ctx.path === prefix) {
      ctx.body = { ok: true, files: store.list(token) }; return;
    }
    const download = ctx.path.match(/^\/api\/engraving-files\/download\/([a-f0-9-]+)$/);
    if (ctx.method === 'GET' && download) {
      const file = store.download(download[1], token);
      ctx.type = 'application/octet-stream';
      ctx.set('Content-Security-Policy', "default-src 'none'; sandbox");
      ctx.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(file.name));
      ctx.length = file.size; ctx.body = fs.createReadStream(file.path); return;
    }
    if (!allowedOrigin) {
      throw new files.UploadError('invalid_origin', 403);
    }
    const match = ctx.path.match(/^\/api\/engraving-files\/([a-f0-9-]+)$/);
    if (!match) throw new files.UploadError('not_found', 404);
    if (ctx.method === 'DELETE') { store.remove(token, match[1]); ctx.body = { ok: true }; return; }
    if (ctx.method !== 'PUT' || ctx.get('Content-Type') !== 'application/octet-stream' || ctx.get('Content-Encoding')) throw new files.UploadError('invalid_upload', 415);
    let name: string;
    try { name = decodeURIComponent(ctx.get('X-File-Name')); } catch { throw new files.UploadError('invalid_filename'); }
    const size = Number(ctx.get('X-File-Size'));
    if (ctx.get('Content-Length') && Number(ctx.get('Content-Length')) !== size) throw new files.UploadError('incomplete_upload');
    // Nginx overwrites X-Real-IP. Do not trust a client-controlled X-Forwarded-For list.
    const remote = ctx.req.socket.remoteAddress || '';
    const ip = ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote) ? (ctx.get('X-Real-IP') || remote) : remote;
    const reservation = store.reserve(token, match[1], name, size, ip);
    const timeout = setTimeout(() => ctx.req.destroy(), 180000);
    try { const file = await store.receive(reservation, ctx.req); ctx.body = { ok: true, file }; }
    finally { clearTimeout(timeout); }
  } catch (error) {
    ctx.status = error instanceof files.UploadError ? error.status : 503;
    ctx.body = { ok: false, error: error instanceof files.UploadError ? error.code : 'uploads_unavailable' };
  }
};

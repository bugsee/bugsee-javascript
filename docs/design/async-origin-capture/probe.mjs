import { createRequire } from 'node:module';
import http from 'node:http';
const require = createRequire(new URL('../../../packages/instrumentation-tests/package.json', import.meta.url));
const pw = require('playwright');
const srv = http.createServer((q,s)=>{ if(q.url==='/'){s.setHeader('content-type','text/html');s.end('<!doctype html><body></body>');} else if(q.url==='/bad.js'){s.setHeader('content-type','text/javascript');s.end('syntax error here(');} else if(q.url==='/bad.json'){s.setHeader('content-type','application/json');s.end('{oops');} else {s.statusCode=404;s.end('nf');}});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const base='http://localhost:'+srv.address().port;
const PAGE = () => {
  const out = [];
  const pend = new Map();
  window.addEventListener('unhandledrejection', (ev) => {
    const id = pend.get(ev.promise); if (!id) return; pend.delete(ev.promise);
    const r = ev.reason; const st = r && typeof r === 'object' ? r.stack : undefined;
    const frames = typeof st === 'string' ? st.split('\n').filter(l => /^\s*at\s|@|:\d+:\d+/.test(l)).length : 0;
    out.push({ id, kind: r === null ? 'null' : typeof r, name: r && r.name, msg: String(r && r.message !== undefined ? r.message : r).slice(0, 70), hasStackProp: typeof st === 'string', frames, mentionsCallsite: typeof st === 'string' && st.includes('callsite') , dom: typeof DOMException !== 'undefined' && r instanceof DOMException});
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cases = {
    'user: async fn throws Error': async function callsite() { throw new Error('x'); },
    'user: Promise.reject(Error)': function callsite() { return Promise.reject(new Error('x')); },
    'user: new Promise rej Error': function callsite() { return new Promise((_, rej) => setTimeout(() => rej(new Error('x')), 5)); },
    'user: Promise.reject("str")': function callsite() { return Promise.reject('str'); },
    'user: Promise.reject(undefined)': function callsite() { return Promise.reject(); },
    'user: Promise.reject({obj})': function callsite() { return Promise.reject({ code: 1 }); },
    'user: await then throw': async function callsite() { await sleep(5); throw new TypeError('late'); },
    'media.play (bad src)': async function callsite() { const v = document.createElement('video'); v.src = 'data:video/mp4;base64,AAAA'; await new Promise((r) => { v.addEventListener('error', r, { once: true }); setTimeout(r, 1500); }); return v.play(); },
    'clipboard.readText': function callsite() { return navigator.clipboard.readText(); },
    'clipboard.writeText': function callsite() { return navigator.clipboard.writeText('x'); },
    'requestFullscreen': function callsite() { return document.documentElement.requestFullscreen(); },
    'getUserMedia(bad constraints)': function callsite() { return navigator.mediaDevices.getUserMedia({}); },
    'getUserMedia(video)': function callsite() { return navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: 'nope' } } }); },
    'permissions.query(bogus)': function callsite() { return navigator.permissions.query({ name: 'bogus' }); },
    'fetch(refused)': function callsite() { return fetch('http://127.0.0.1:1/x'); },
    'fetch(bad url)': function callsite() { return fetch('http://[bad'); },
    'fetch(cors)': function callsite() { return fetch('http://127.0.0.1:1/x', { mode: 'cors' }); },
    'response.json(bad)': async function callsite() { const r = await fetch('/bad.json'); return r.json(); },
    'Image.decode(bad)': function callsite() { const i = new Image(); i.src = 'data:image/png;base64,AAAA'; return i.decode(); },
    'createImageBitmap(bad)': function callsite() { return createImageBitmap(new Blob(['x'])); },
    'subtle.digest(bogus)': function callsite() { return crypto.subtle.digest('bogus', new Uint8Array(1)); },
    'subtle.importKey(bad)': function callsite() { return crypto.subtle.importKey('raw', new Uint8Array(1), 'AES-GCM', false, ['encrypt']); },
    'serviceWorker.register(404)': function callsite() { return navigator.serviceWorker.register('/nope.js'); },
    'navigator.share({})': function callsite() { return navigator.share({}); },
    'orientation.lock': function callsite() { return screen.orientation.lock('portrait'); },
    'wakeLock.request': function callsite() { return navigator.wakeLock.request('screen'); },
    'FontFace.load(bad)': function callsite() { return new FontFace('x', 'url(/nope.woff)').load(); },
    'decodeAudioData(bad)': function callsite() { return new AudioContext().decodeAudioData(new ArrayBuffer(8)); },
    'RTC.setRemoteDescription(bad)': function callsite() { return new RTCPeerConnection().setRemoteDescription({ type: 'answer', sdp: 'x' }); },
    'RTC.addIceCandidate(bad)': function callsite() { return new RTCPeerConnection().addIceCandidate({ candidate: 'x', sdpMid: 'zz' }); },
    'import(404)': function callsite() { return import('/nope.mjs'); },
    'import(syntax err)': function callsite() { return import('/bad.js'); },
    'WebAssembly.compile(bad)': function callsite() { return WebAssembly.compile(new Uint8Array([0, 1, 2])); },
    'WebAssembly.instantiate(bad)': function callsite() { return WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 9, 0, 0, 0])); },
    'OffscreenCanvas.convertToBlob(0)': function callsite() { return new OffscreenCanvas(0, 0).convertToBlob(); },
    'storage.getDirectory+bad': async function callsite() { const d = await navigator.storage.getDirectory(); return d.getFileHandle('a/b'); },
    'caches.open("")+match': function callsite() { return caches.match(new Request('/x'), { cacheName: 1n }); },
    'document.fonts.load(bad)': function callsite() { return document.fonts.load('???'); },
    'Notification.requestPermission': function callsite() { return Notification.requestPermission().then(() => { throw new Error('after'); }); },
    'ReadableStream cancel err': function callsite() { return new ReadableStream({ cancel() { throw new Error('c'); } }).cancel(); },
    'Blob.text on revoked? stream': function callsite() { const rs = new ReadableStream({ start(c) { c.error(new Error('e')); } }); return rs.getReader().read(); },
    'IDB promisified (event err)': function callsite() { return new Promise((_, rej) => { const q = indexedDB.open('x', 0); q.onerror = () => rej(q.error); }); },
    'CSS paintWorklet.addModule(404)': function callsite() { return CSS.paintWorklet.addModule('/nope.js'); },
    'structuredClone via postMessage': function callsite() { return Promise.resolve().then(() => structuredClone(() => {})); },
  };
  return new Promise(async (resolve) => {
    const started = [];
    for (const [id, fn] of Object.entries(cases)) {
      try { const p = fn(); pend.set(p, id); started.push(id); } catch (e) { out.push({ id, syncThrow: true, name: e.name, frames: (e.stack||'').split('\n').length }); }
    }
    await sleep(5000);
    const seen = new Set(out.map((o) => o.id));
    for (const id of started) if (!seen.has(id)) out.push({ id, noEventWithin5s: true });
    resolve(out);
  });
};
const only = process.argv[2];
for (const name of ['chromium', 'firefox', 'webkit']) {
  if (only && only !== name) continue;
  let b;
  try {
    b = await pw[name].launch({ headless: true, ...(process.env['PW_'+name] ? { executablePath: process.env['PW_'+name] } : {}) });
    const ctx = await b.newContext({ permissions: [] });
    const p = await ctx.newPage();
    await p.goto(base + '/');
    const res = await p.evaluate(`(${PAGE.toString()})()`);
    console.log('=== ' + name + ' ' + b.version());
    for (const r of res) console.log(JSON.stringify(r));
  } catch (e) { console.log('=== ' + name + ' FAILED ' + String(e).slice(0, 200)); }
  finally { await b?.close(); }
}
srv.close();

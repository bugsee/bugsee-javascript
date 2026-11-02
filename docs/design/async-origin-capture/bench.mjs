import { createRequire } from 'node:module';
import http from 'node:http';
const require = createRequire('/Volumes/External2TB/Projects/Bugsee/javascript/packages/instrumentation-tests/package.json');
const pw = require('playwright');
const srv = http.createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<!doctype html><body></body>');});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const PAGE = async () => {
  const N = 20000, ROUNDS = 5;
  const data = new Uint8Array(16);
  const native = (...a) => crypto.subtle.digest('SHA-1', data);          // cheap real async platform call
  const origins = new WeakMap();
  const isThenable = (p) => p !== null && typeof p === 'object' && typeof p.then === 'function';
  // ONE generic factory: every patched method goes through it
  const make = (original, { capture = true } = {}) => function (...args) {
    const origin = capture ? new Error() : undefined;
    const p = original.apply(this, args);
    if (!isThenable(p)) return p;
    return p.then(undefined, (r) => { if (origin && r !== null && typeof r === 'object') origins.set(r, origin); throw r; });
  };
  const orig = (a) => crypto.subtle.digest('SHA-1', a);
  const variants = {
    'native call': () => orig(data),
    'wrapper: apply+then, NO Error': make(orig, { capture: false }),
    'wrapper: apply+then+new Error() (proposed)': make(orig),
  };
  // hand-specialised (no rest args, no factory) to show the factory itself costs nothing
  const special = function (a) { const o = new Error(); const p = orig(a); return p.then(undefined, (r) => { origins.set(r, o); throw r; }); };
  variants['hand-written specialised wrapper (+Error)'] = () => special(data);
  const res = {};
  for (const [name, fn] of Object.entries(variants)) {
    const times = [];
    for (let k = 0; k < ROUNDS; k++) {
      const t0 = performance.now();
      const ps = new Array(N);
      for (let i = 0; i < N; i++) ps[i] = name === 'native call' ? orig(data) : fn(data);
      await Promise.all(ps);
      times.push((performance.now() - t0) / N * 1000);
    }
    times.sort((a, b) => a - b);
    res[name] = +times[Math.floor(ROUNDS / 2)].toFixed(2) + ' us/call (median of ' + ROUNDS + ')';
  }
  // cost of Error capture alone, and of reading .stack (only paid on rejection)
  let t0 = performance.now(); let keep; for (let i = 0; i < 200000; i++) keep = new Error(); res['new Error() alone'] = ((performance.now() - t0) / 200000 * 1000).toFixed(2) + ' us';
  t0 = performance.now(); let n = 0; for (let i = 0; i < 20000; i++) n += new Error().stack.length; res['new Error().stack (format) alone'] = ((performance.now() - t0) / 20000 * 1000).toFixed(2) + ' us';
  return res;
};
for (const [name, exe] of [['chromium', null], ['firefox', process.env.PW_firefox]]) {
  let b; try {
    b = await pw[name].launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
    const p = await b.newPage(); await p.goto('http://localhost:' + srv.address().port + '/');
    console.log('=== ' + name + ' ' + b.version()); console.log(JSON.stringify(await p.evaluate(`(${PAGE.toString()})()`), null, 1));
  } catch (e) { console.log(name, 'FAILED', String(e).slice(0, 150)); } finally { await b?.close(); }
}
srv.close();

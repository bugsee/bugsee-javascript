var a = 2;
var r = 0.6;
var n = `image/webp`;
function i(e) {
  return e === void 0 || !Number.isFinite(e) ? a : Math.min(60, Math.max(1, Math.round(e)));
}
function t(e) {
  return e === void 0 || !Number.isFinite(e) ? r : Math.min(1, Math.max(0, e));
}
function u(e) {
  return e === `image/jpeg` ? `image/jpeg` : n;
}
function m(e) {
  return e === `all` ? `all` : i(e);
}
function o(e = {}) {
  return {
    recordCanvas: !0,
    sampling: { canvas: m(e.fps) },
    dataURLOptions: { type: u(e.imageType), quality: t(e.quality) },
  };
}

export { o as createCanvasRecordConfig };
//# debugId=0ce56217-9be4-5485-b3d2-3b96675bd2ff

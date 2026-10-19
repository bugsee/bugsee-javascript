---
'@bugsee/node': minor
'@bugsee/electron': minor
---

New `@bugsee/node` launch option `hardwareExtras`: a function read live on every environment assemble whose `gpu` (`{vendor?, renderer?, gl_version?, gl_extensions?}`) is merged into `environment.hardware`. Only that typed key is merged, it never overrides the built-in hardware fields, and `undefined`, an unusable result, or a throw adds nothing (a throw goes to `onError`).

`@bugsee/electron` uses it to report the GPU as `environment.hardware.gpu`: `launchMain` reads `app.getGPUInfo('basic')` once (when `app` provides it), maps the active device's `vendorString`/`deviceString`, and the field appears on every report assembled after it settles. A rejection, an app without `getGPUInfo`, or a result with no usable strings omits the field; a late result after `client.stop()` is ignored. `gpuInfoType` (`'basic'` default, or `'complete'`) selects the `getGPUInfo` argument; `auxAttributes` GL strings are used when present. A caller-supplied `hardwareExtras` overrides the Electron GPU field by field.

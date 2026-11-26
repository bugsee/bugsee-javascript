---
'@bugsee/nuxt': patch
---

The module's default export now carries an explicit `NuxtModule<ModuleOptions>` type, imported from `nuxt/schema` (the `nuxt` peer), instead of an inferred one. Nuxt 4.6 and later ship a `typesVersions` map that keeps TypeScript from naming the inferred type, so the declaration build failed against them. The type itself is unchanged.

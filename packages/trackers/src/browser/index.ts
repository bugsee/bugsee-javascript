// Reserved `@bugsee/trackers/browser` entry. Platform tracker implementations that need DOM/Web-API APIs live
// under src/browser/ and are exported from here; nothing is implemented yet, so this entry is a documented
// placeholder. Keeping the subpath in package.json `exports` now means later slices add files WITHOUT
// changing the package contract. The portable root entry must never import from this directory.
export {};

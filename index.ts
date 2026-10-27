// pi-extensions
//
// The workspace root as a loadable module.
//
// WHY THIS FILE EXISTS
// The root of this repository is a Pi package: its package.json carries a `pi`
// manifest naming the extensions it ships, so Pi can load the repository by
// path. A directory that Pi loads as a package must ALSO be resolvable as a
// module, because the loader falls back to handing the directory itself to
// the module loader when a package declares no resources. A workspace root
// with neither an entry point nor a manifest produced exactly that failure:
//
//   Error: Failed to load extension "/home/hleyf/Projects/pi-extensions":
//   Failed to load extension: Cannot find module '/home/hleyf/Projects/pi-extensions'
//
// which killed every agent subprocess before the agent started.
//
// So the root names an entry point, and this file is it. It re-exports the
// shared engine — the one thing in this workspace that is a library — so the
// root has a public surface that is worth resolving.
//
// The extensions themselves live in the workspace packages and are named by
// the `pi` manifest, not by this file.
//
// This module has no runtime dependency on Pi: the engine's Pi types are
// `import type` only and are erased before the module runs.

export * from "./packages/core/src/index.ts";

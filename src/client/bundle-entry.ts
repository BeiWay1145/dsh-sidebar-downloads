/**
 * Thin bundling shim around the real client entry.
 *
 * esbuild's IIFE output has no export surface, so this file re-exports the
 * plugin API onto a global the module-loader wrapper reads back when it
 * builds `module.exports`. Keeping the shim (rather than hand-rolling the
 * envelope around esbuild's internals) means the wrapper only ever depends
 * on this one global name.
 */
import { apply, inject } from './index.tsx'

;(globalThis as any).__dshExports = { apply, inject }

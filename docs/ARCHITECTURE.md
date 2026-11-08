# Architecture

See PLAN §4 for the authoritative diagram. Package boundaries and their contracts:

| Boundary                           | Contract                                                            |
| ---------------------------------- | ------------------------------------------------------------------- |
| Document schema                    | `packages/contracts/src/document.ts`                                |
| Persistent naming grammar          | `packages/contracts/src/naming.ts`                                  |
| Kernel worker (Comlink)            | `packages/contracts/src/kernel.ts` (`KernelApi`)                    |
| C++ façade (Wasm)                  | `packages/kernel/src/whittle_kernel.h`                              |
| Viewport engine                    | `packages/contracts/src/viewport.ts` (`Viewport`, `CreateViewport`) |
| Runtime / device tier / test hooks | `packages/contracts/src/runtime.ts`                                 |

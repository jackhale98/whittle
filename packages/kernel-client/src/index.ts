/**
 * @whittle/kernel-client — main-thread entry. Import this from the app; it spawns the kernel
 * worker (./worker.ts) and never loads Wasm on the main thread.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export {
  createKernelClient,
  type KernelClient,
  type KernelClientOptions,
  type KernelStatusStream,
} from './client';
export { isStatusMessage, STATUS_MESSAGE_TAG, type StatusMessage } from './protocol';

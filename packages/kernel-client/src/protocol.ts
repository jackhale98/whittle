/**
 * Out-of-band messages from the kernel worker to the main thread. They share the worker's port
 * with Comlink; Comlink ignores messages that do not carry one of its request ids.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { KernelStatus } from '@wren-cad/contracts';

export const STATUS_MESSAGE_TAG = '__wrenKernelStatus' as const;

export interface StatusMessage {
  [STATUS_MESSAGE_TAG]: KernelStatus;
}

export function statusMessage(status: KernelStatus): StatusMessage {
  return { [STATUS_MESSAGE_TAG]: status };
}

export function isStatusMessage(data: unknown): data is StatusMessage {
  if (typeof data !== 'object' || data === null || !(STATUS_MESSAGE_TAG in data)) return false;
  const status = (data as StatusMessage)[STATUS_MESSAGE_TAG];
  return typeof status === 'object' && status !== null && typeof status.state === 'string';
}

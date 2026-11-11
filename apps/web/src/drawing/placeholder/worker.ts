/**
 * PLACEHOLDER drawing worker (ADR-092): exposes `DrawingKernelApi` over Comlink. The real HLR
 * worker (packages/kernel) replaces it.
 */

import { expose } from 'comlink';
import { PlaceholderDrawingKernel } from './kernel';

expose(new PlaceholderDrawingKernel());

import type { KernelStatus, RuntimeDiagnostics } from '@whittle/contracts';
import type { ReactNode } from 'react';
import type { ThemeSetting } from '../theme';

/** Props every shell accepts. The shell never touches Wasm or the kernel: it only renders state. */
export interface ShellProps {
  documentName: string;
  kernelStatus: KernelStatus;
  /**
   * The viewport (typically a `<canvas>`). It is mounted inside `[data-testid="viewport-slot"]`,
   * a positioned element that fills the available area, so `width: 100%; height: 100%` works.
   */
  viewport: ReactNode;
  diagnostics?: RuntimeDiagnostics;
  /** Controlled theme. Omit to let the shell manage + persist it (localStorage). */
  theme?: ThemeSetting;
  onThemeChange?(theme: ThemeSetting): void;
  onUndo?(): void;
  onRedo?(): void;
  onExport?(): void;
}

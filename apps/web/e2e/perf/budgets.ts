/**
 * Performance budgets (PLAN §10) and the CI factor for software rendering. See ADR-009 in
 * docs/DECISIONS.md for how the factor was chosen.
 *
 * Budgets are stated for real hardware. GitHub's 2-vCPU runners have no GPU (SwiftShader/llvmpipe
 * WebGL) and are 2-4x slower than a mid-range laptop for main-thread work, so CI multiplies the
 * time budgets by `PERF_FACTOR`. Override with WHITTLE_PERF_FACTOR (e.g. 1 on real hardware).
 * Memory is not scaled: a 1 GB peak is a 1 GB peak.
 */
export const PERF_FACTOR = Number(process.env.WHITTLE_PERF_FACTOR ?? (process.env.CI ? 3 : 1.5));

export const BUDGETS = {
  /** Time to interactive shell, cold, fast 4G (ms). */
  shellTtiMs: 1500 * PERF_FACTOR,
  /** Peak memory, iPad tier, typical part (bytes). Not scaled. */
  peakMemoryBytes: 1024 * 1024 * 1024,
} as const;

/** Chrome DevTools "Fast 4G"-class link: 9 Mbit/s down, 1.5 Mbit/s up, 170 ms RTT. */
export const FAST_4G = {
  offline: false,
  downloadThroughput: (9 * 1024 * 1024) / 8,
  uploadThroughput: (1.5 * 1024 * 1024) / 8,
  latency: 170,
} as const;

/**
 * Factor for the viewport perf probes' assertions (WREN_PERF_ASSERT=1), the same rule as the web
 * app's budgets (apps/web/e2e/perf/budgets.ts, ADR-010): budgets are stated for real hardware, CI
 * runners rasterise in software (SwiftShader) on 2 vCPUs, so CI multiplies time budgets by 3 and
 * local runs by 1.5. Override with WREN_PERF_FACTOR (1 on real hardware).
 */
export const PERF_FACTOR = Number(process.env.WREN_PERF_FACTOR ?? (process.env.CI ? 3 : 1.5));

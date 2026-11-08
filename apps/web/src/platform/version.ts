/** App version + git sha, injected at build time through vite `define`. */
export const APP_SEMVER: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
export const GIT_SHA: string = typeof __GIT_SHA__ === 'string' ? __GIT_SHA__ : 'dev';

/** e.g. `0.1.0+a1b2c3d` (the `appVersion` of `RuntimeDiagnostics`). */
export const APP_VERSION = `${APP_SEMVER}+${GIT_SHA}`;

// SPDX-License-Identifier: GPL-3.0-or-later
/** Vite/Vitest `?raw` imports: the file's text (tests only; the Worker runtime has no Node types). */
declare module '*?raw' {
  const text: string;
  export default text;
}

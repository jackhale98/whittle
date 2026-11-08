import { useCallback, useEffect, useState } from 'react';
import type { ThemeName } from './tokens';

/** `system` follows `prefers-color-scheme`; `light`/`dark` set `data-theme` on `<html>`. */
export type ThemeSetting = ThemeName | 'system';

const STORAGE_KEY = 'whittle.theme';

function isSetting(v: unknown): v is ThemeSetting {
  return v === 'light' || v === 'dark' || v === 'system';
}

export function readStoredTheme(): ThemeSetting {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (isSetting(v)) return v;
  } catch {
    /* storage unavailable (private mode, blocked): fall through */
  }
  return 'system';
}

function storeTheme(setting: ThemeSetting): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, setting);
  } catch {
    /* ignore */
  }
}

/** Reflect a setting on the document element. Call once at startup (before first paint). */
export function applyTheme(setting: ThemeSetting, root: HTMLElement = document.documentElement) {
  if (setting === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', setting);
}

/** Apply the persisted theme at startup so there is no flash of the wrong theme. */
export function initTheme(): ThemeSetting {
  const s = readStoredTheme();
  applyTheme(s);
  return s;
}

export function systemTheme(): ThemeName {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function useSystemTheme(): ThemeName {
  const [theme, setTheme] = useState<ThemeName>(systemTheme);
  useEffect(() => {
    const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = () => setTheme(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return theme;
}

export interface ThemeControl {
  setting: ThemeSetting;
  resolved: ThemeName;
  setSetting(next: ThemeSetting): void;
  /** Flip between light and dark based on what is currently shown. */
  toggle(): void;
}

/**
 * Theme state. Controlled when `value` is given (the app owns persistence); otherwise it reads and
 * persists to localStorage. Either way the setting is reflected on `<html data-theme>`.
 */
export function useTheme(options: {
  value?: ThemeSetting;
  onChange?(next: ThemeSetting): void;
}): ThemeControl {
  const { value, onChange } = options;
  const [internal, setInternal] = useState<ThemeSetting>(readStoredTheme);
  const setting = value ?? internal;
  const system = useSystemTheme();
  const resolved = setting === 'system' ? system : setting;

  useEffect(() => {
    applyTheme(setting);
  }, [setting]);

  const setSetting = useCallback(
    (next: ThemeSetting) => {
      if (value === undefined) {
        setInternal(next);
        storeTheme(next);
      }
      onChange?.(next);
    },
    [value, onChange],
  );

  const toggle = useCallback(
    () => setSetting(resolved === 'dark' ? 'light' : 'dark'),
    [resolved, setSetting],
  );

  return { setting, resolved, setSetting, toggle };
}

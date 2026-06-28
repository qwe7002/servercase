import type { TerminalColorScheme } from '../../electron/shared';

/** Background/foreground for each terminal color scheme (shared with mobile). */
export const TERMINAL_SCHEMES: Record<
  TerminalColorScheme,
  { background: string; foreground: string }
> = {
  charcoal: { background: '#0b0d12', foreground: '#d6dbe5' },
  black: { background: '#000000', foreground: '#e5e5e5' },
  light: { background: '#f5f5f5', foreground: '#1c1c1c' },
  solarized: { background: '#002b36', foreground: '#93a1a1' },
};

export const TERMINAL_SCHEME_LABELS: Record<TerminalColorScheme, string> = {
  charcoal: 'Charcoal',
  black: 'Black',
  light: 'Light',
  solarized: 'Solarized',
};

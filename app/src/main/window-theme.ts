// The window's own background in each theme: the color shown before the page paints and while it resizes, so a dark
// window never flashes white (or a light one black). Equal to --color-app in tokens.css (checked by a test).
export const WINDOW_BACKGROUND = { dark: "#121212", light: "#fafafa" } as const;

export const windowBackground = (dark: boolean): string => (dark ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light);

/**
 * Cross-platform standalone management page entry (`page`) for Codex Desktop
 * (Settings -> Plugin Pages) and CH Web (Plugins top tab bar).
 */

import { mountMcpHub } from "../shared/ui.mjs";

export async function mount(root, api) {
  return mountMcpHub(root, {
    invoke: (method, params) => api.backend.invoke(method, params),
    getLocale: () => api.locale,
    onLocaleChange: (cb) => api.onLocaleChange(cb),
    getColorScheme: () => api.colorScheme,
    onColorSchemeChange: (cb) => api.onColorSchemeChange(cb),
    signal: api.signal,
  });
}

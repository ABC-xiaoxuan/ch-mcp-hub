/**
 * CH Web host entry — registers "MCP Hub / MCP 管理" directly in the left primary sidebar
 * via `api.panels.register({ placement: "main" })` and mounts the shared MCP Hub UI.
 */

import { mountMcpHub } from "../shared/ui.mjs";

function detectColorScheme(doc) {
  const body = doc.body;
  const html = doc.documentElement;
  if (
    body?.hasAttribute("data-ds-dark-theme") ||
    html?.hasAttribute("data-ds-dark-theme") ||
    html?.getAttribute("data-theme") === "dark" ||
    body?.getAttribute("data-theme") === "dark" ||
    html?.classList.contains("dark") ||
    body?.classList.contains("dark")
  ) {
    return "dark";
  }
  const win = doc.defaultView;
  if (html && win?.getComputedStyle) {
    const scheme = win.getComputedStyle(html).colorScheme;
    if (scheme === "dark") return "dark";
    if (scheme === "light") return "light";
  }
  if (win?.matchMedia?.("(prefers-color-scheme: dark)")?.matches) {
    return "dark";
  }
  return "light";
}

function detectLocale(doc) {
  const lang = doc.documentElement?.lang || doc.defaultView?.navigator?.language || "en";
  return lang.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export async function activate(api) {
  const disposePanel = api.panels.register({
    id: "mcp-hub",
    title: {
      en: "MCP Hub",
      "zh-CN": "MCP 管理",
    },
    placement: "main",
    render(container, panelSignal) {
      const doc = container.ownerDocument;
      const win = doc.defaultView;
      const schemeListeners = new Set();
      const localeListeners = new Set();

      let currentScheme = detectColorScheme(doc);
      let currentLocale = detectLocale(doc);

      const syncAppearance = () => {
        const nextScheme = detectColorScheme(doc);
        if (nextScheme !== currentScheme) {
          currentScheme = nextScheme;
          for (const fn of schemeListeners) fn(currentScheme);
        }
        const nextLocale = detectLocale(doc);
        if (nextLocale !== currentLocale) {
          currentLocale = nextLocale;
          for (const fn of localeListeners) fn(currentLocale);
        }
      };

      const observer = new MutationObserver(syncAppearance);
      if (doc.body) {
        observer.observe(doc.body, {
          attributes: true,
          attributeFilter: ["data-ds-dark-theme", "class", "data-theme"],
        });
      }
      if (doc.documentElement) {
        observer.observe(doc.documentElement, {
          attributes: true,
          attributeFilter: ["lang", "data-theme", "class"],
        });
      }

      const media = win?.matchMedia?.("(prefers-color-scheme: dark)");
      media?.addEventListener?.("change", syncAppearance, { signal: panelSignal });

      const unmount = mountMcpHub(container, {
        invoke: (method, params) => api.backend.invoke(method, params),
        getLocale: () => currentLocale,
        onLocaleChange: (cb) => {
          localeListeners.add(cb);
          return () => localeListeners.delete(cb);
        },
        getColorScheme: () => currentScheme,
        onColorSchemeChange: (cb) => {
          schemeListeners.add(cb);
          return () => schemeListeners.delete(cb);
        },
        signal: panelSignal,
      });

      return () => {
        observer.disconnect();
        unmount();
      };
    },
  });

  api.track(disposePanel);
  return () => {
    disposePanel();
  };
}

/**
 * Crisp 1.5px stroke inline SVG icon factory (zero emoji, zero external icon fonts).
 */

const SVG_PATHS = {
  hub: [
    '<circle cx="12" cy="12" r="2.75" />',
    '<circle cx="5" cy="6" r="2" />',
    '<circle cx="19" cy="6" r="2" />',
    '<circle cx="5" cy="18" r="2" />',
    '<circle cx="19" cy="18" r="2" />',
    '<path d="M6.6 7.3L9.8 10.1M17.4 7.3L14.2 10.1M6.6 16.7L9.8 13.9M17.4 16.7L14.2 13.9" />',
  ],
  plus: ['<path d="M12 5v14M5 12h14" />'],
  refresh: [
    '<path d="M20 11a8 8 0 1 0 2 5.3" />',
    '<path d="M20 4v7h-7" />',
  ],
  upload: [
    '<path d="M12 16V4m0 0-4 4m4-4 4 4" />',
    '<path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />',
  ],
  download: [
    '<path d="M12 4v12m0 0-4-4m4 4 4-4" />',
    '<path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />',
  ],
  search: [
    '<circle cx="11" cy="11" r="7" />',
    '<path d="m20 20-3.5-3.5" />',
  ],
  sync: [
    '<path d="M7 7h11l-3-3m3 3-3 3" />',
    '<path d="M17 17H6l3 3m-3-3 3-3" />',
  ],
  radar: [
    '<circle cx="12" cy="12" r="8.5" />',
    '<circle cx="12" cy="12" r="4.5" />',
    '<circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />',
  ],
  edit: [
    '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5Z" />',
  ],
  trash: [
    '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />',
  ],
  copy: [
    '<rect x="9" y="9" width="11" height="11" rx="2" />',
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />',
  ],
  check: ['<path d="m5 12.5 4.5 4.5L19 7.5" />'],
  close: ['<path d="M18 6 6 18M6 6l12 12" />'],
  globe: [
    '<circle cx="12" cy="12" r="9" />',
    '<path d="M3.6 9h16.8M3.6 15h16.8M12 3a13 13 0 0 0 0 18M12 3a13 13 0 0 1 0 18" />',
  ],
  terminal: [
    '<rect x="3" y="4" width="18" height="16" rx="2.5" />',
    '<path d="m7.5 9.5 3 2.5-3 2.5M12.5 14.5h4" />',
  ],
  lock: [
    '<rect x="5" y="11" width="14" height="9" rx="2" />',
    '<path d="M8 11V8a4 4 0 0 1 8 0v3" />',
  ],
  external: [
    '<path d="M14 5h5v5M19 5l-8.5 8.5" />',
    '<path d="M17 13v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />',
  ],
  history: [
    '<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />',
    '<path d="M3 3v5h5M12 7v5l3 2" />',
  ],
  warning: [
    '<path d="M12 3.5 21 19.5H3L12 3.5Z" />',
    '<path d="M12 9.5v4.5M12 17h.01" />',
  ],
  eye: [
    '<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" />',
    '<circle cx="12" cy="12" r="2.5" />',
  ],
  spark: [
    '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />',
  ],
  code: [
    '<path d="m8 9-4 3 4 3M16 9l4 3-4 3M13.5 6l-3 12" />',
  ],
  layers: [
    '<path d="m12 3 9 4.5-9 4.5-9-4.5L12 3Z" />',
    '<path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5" />',
  ],
  bolt: [
    '<path d="M13 2 4.5 13.5H12L11 22l8.5-11.5H12L13 2Z" />',
  ],
};

export function iconSvg(name, size = 15) {
  const paths = SVG_PATHS[name] ?? SVG_PATHS.hub;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.join("")}</svg>`;
}

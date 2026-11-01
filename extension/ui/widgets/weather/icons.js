// Two-tone weather glyphs (Lucide geometry, ISC License) for the weather widget and the dashboard header chip.
// Parts carry classes so CSS can tint them: .wx-sun, .wx-moon, .wx-cloud, .wx-rain, .wx-snow, .wx-bolt, .wx-fog.
// Every part strokes currentColor unless styles/widgets/weather.css tints it, so the glyphs also work uncolored.
import { registerIcons } from '../../icons.js';

const CLOUD_TALL = '<path class="wx-cloud" d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>';
const SUN_RAYS = '<path class="wx-sun" d="M12 2v2"/><path class="wx-sun" d="m4.93 4.93 1.41 1.41"/><path class="wx-sun" d="M20 12h2"/><path class="wx-sun" d="m19.07 4.93-1.41 1.41"/><path class="wx-sun" d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/>';
const MOON_ARC = '<path class="wx-moon" d="M10.188 8.5A6 6 0 0 1 16 4a1 1 0 0 0 6 6 6 6 0 0 1-3 5.197"/>';
const SMALL_CLOUD = '<path class="wx-cloud" d="M3 20a5 5 0 1 1 8.9-4H13a3 3 0 0 1 2 5.24"/>';

export const WEATHER_GLYPHS = Object.freeze({
  'wx-sun': '<circle class="wx-sun" cx="12" cy="12" r="4"/><path class="wx-sun" d="M12 2v2"/><path class="wx-sun" d="M12 20v2"/><path class="wx-sun" d="m4.93 4.93 1.41 1.41"/><path class="wx-sun" d="m17.66 17.66 1.41 1.41"/><path class="wx-sun" d="M2 12h2"/><path class="wx-sun" d="M20 12h2"/><path class="wx-sun" d="m6.34 17.66-1.41 1.41"/><path class="wx-sun" d="m19.07 4.93-1.41 1.41"/>',
  'wx-moon': '<path class="wx-moon" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  'wx-cloud-sun': `${SUN_RAYS}<path class="wx-cloud" d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>`,
  'wx-cloud-moon': `${MOON_ARC}<path class="wx-cloud" d="M13 16a3 3 0 1 1 0 6H7a5 5 0 1 1 4.9-6Z"/>`,
  'wx-cloud': '<path class="wx-cloud" d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  'wx-fog': `${CLOUD_TALL}<path class="wx-fog" d="M16 17H7"/><path class="wx-fog" d="M17 21H9"/>`,
  'wx-drizzle': `${CLOUD_TALL}<path class="wx-rain" d="M8 19v1"/><path class="wx-rain" d="M8 14v1"/><path class="wx-rain" d="M16 19v1"/><path class="wx-rain" d="M16 14v1"/><path class="wx-rain" d="M12 21v1"/><path class="wx-rain" d="M12 16v1"/>`,
  'wx-rain': `${CLOUD_TALL}<path class="wx-rain" d="M16 14v6"/><path class="wx-rain" d="M8 14v6"/><path class="wx-rain" d="M12 16v6"/>`,
  'wx-showers-day': `${SUN_RAYS}${SMALL_CLOUD}<path class="wx-rain" d="M11 20v2"/><path class="wx-rain" d="M7 19v2"/>`,
  'wx-showers-night': `${MOON_ARC}${SMALL_CLOUD}<path class="wx-rain" d="M11 20v2"/><path class="wx-rain" d="M7 19v2"/>`,
  'wx-sleet': `${CLOUD_TALL}<path class="wx-rain" d="M8 14v2"/><path class="wx-snow" d="M8 20h.01"/><path class="wx-rain" d="M16 14v2"/><path class="wx-snow" d="M16 20h.01"/><path class="wx-rain" d="M12 16v2"/><path class="wx-snow" d="M12 22h.01"/>`,
  'wx-snow': `${CLOUD_TALL}<path class="wx-snow" d="M8 15h.01"/><path class="wx-snow" d="M8 19h.01"/><path class="wx-snow" d="M12 17h.01"/><path class="wx-snow" d="M12 21h.01"/><path class="wx-snow" d="M16 15h.01"/><path class="wx-snow" d="M16 19h.01"/>`,
  'wx-storm': '<path class="wx-cloud" d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path class="wx-bolt" d="m13 12-3 5h4l-3 5"/>',
  'wx-hail': '<path class="wx-cloud" d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path class="wx-bolt" d="m13 12-3 5h4l-3 5"/><path class="wx-snow" d="M7 20h.01"/><path class="wx-snow" d="M17 21h.01"/>',
  // Setup, errors and the place line.
  'cloud-off': '<path d="m2 2 20 20"/><path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193"/><path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07"/>',
  'navigation-2': '<polygon points="12 2 19 21 12 17 5 21 12 2"/>',
  'locate-fixed': '<line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="5"/><line x1="12" x2="12" y1="19" y2="22"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
});

registerIcons(WEATHER_GLYPHS);

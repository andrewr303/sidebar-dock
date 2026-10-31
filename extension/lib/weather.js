// Weather from Open-Meteo (no key; data CC BY 4.0, free for non-commercial use) for the dashboard weather widget.
// Pure helpers (condition codes, units, URLs, response parsing, formatting) plus small fetch wrappers that take an
// injectable fetch, so tests run in Node. Reverse geocoding for "Use my location" uses BigDataCloud's client endpoint,
// which only receives the coordinates the person chose to share.

export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
export const REVERSE_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
/** Host access the widget asks for when a place is chosen (search) or located (adds reverse geocoding). */
export const WEATHER_ORIGINS = Object.freeze([FORECAST_URL, GEOCODING_URL]);
export const LOCATE_ORIGINS = Object.freeze([FORECAST_URL, GEOCODING_URL, REVERSE_URL]);
export const ATTRIBUTION = Object.freeze({ label: 'Weather data by Open-Meteo.com', href: 'https://open-meteo.com/' });
/** Cached forecasts older than this refresh in the background. */
export const WEATHER_MAX_AGE = 20 * 60_000;

// WMO 4677 codes as Open-Meteo reports them: [label, kind]. Kinds pick the glyph and the tint.
const WMO = {
  0: ['Clear', 'clear'], 1: ['Mostly clear', 'partly'], 2: ['Partly cloudy', 'partly'], 3: ['Overcast', 'cloudy'],
  45: ['Fog', 'fog'], 48: ['Freezing fog', 'fog'],
  51: ['Light drizzle', 'drizzle'], 53: ['Drizzle', 'drizzle'], 55: ['Heavy drizzle', 'drizzle'],
  56: ['Freezing drizzle', 'sleet'], 57: ['Heavy freezing drizzle', 'sleet'],
  61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'rain'],
  66: ['Freezing rain', 'sleet'], 67: ['Heavy freezing rain', 'sleet'],
  71: ['Light snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'], 77: ['Snow grains', 'snow'],
  80: ['Light showers', 'showers'], 81: ['Showers', 'showers'], 82: ['Heavy showers', 'showers'],
  85: ['Light snow showers', 'snow'], 86: ['Heavy snow showers', 'snow'],
  95: ['Thunderstorm', 'storm'], 96: ['Thunderstorm with hail', 'hail'], 99: ['Severe thunderstorm with hail', 'hail'],
};
// kind -> [day glyph, night glyph, tint]. Glyphs are the wx-* icons registered by ui/widgets/weather/icons.js.
const KINDS = {
  clear: ['wx-sun', 'wx-moon', 'sun'],
  partly: ['wx-cloud-sun', 'wx-cloud-moon', 'sun'],
  cloudy: ['wx-cloud', 'wx-cloud', 'cloud'],
  fog: ['wx-fog', 'wx-fog', 'cloud'],
  drizzle: ['wx-drizzle', 'wx-drizzle', 'rain'],
  rain: ['wx-rain', 'wx-rain', 'rain'],
  showers: ['wx-showers-day', 'wx-showers-night', 'rain'],
  sleet: ['wx-sleet', 'wx-sleet', 'snow'],
  snow: ['wx-snow', 'wx-snow', 'snow'],
  storm: ['wx-storm', 'wx-storm', 'storm'],
  hail: ['wx-hail', 'wx-hail', 'storm'],
};

/** { code, label, kind, icon, tint } for a WMO code; night swaps sun glyphs for moon ones. Unknown codes read as cloudy. */
export function weatherCondition(code, isDay = true) {
  const known = code == null || code === '' ? null : WMO[Number(code)];
  const [label, kind] = known || ['Unknown conditions', 'cloudy'];
  const [dayIcon, nightIcon, tint] = KINDS[kind];
  const night = isDay === false || isDay === 0;
  return { code: known ? Number(code) : null, label, kind, icon: night ? nightIcon : dayIcon, tint: night && tint === 'sun' ? 'moon' : tint };
}

// Places that measure air temperature in Fahrenheit (and their territories).
const FAHRENHEIT_REGIONS = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH', 'LR']);

/** Region subtag of a locale ('en-US' -> 'US', 'en' -> 'US' through likely subtags, 'fr' -> 'FR'). */
export function regionOf(locale) {
  const tag = String(locale || '').trim() || 'en-US';
  try {
    const parsed = new Intl.Locale(tag);
    return String(parsed.region || parsed.maximize?.().region || '').toUpperCase();
  } catch {
    return (/[-_]([a-z]{2})(?:[-_]|$)/i.exec(tag)?.[1] || '').toUpperCase();
  }
}

/** 'f' or 'c' for a units setting: 'auto' follows the locale's region. */
export function resolveUnit(units = 'auto', locale = globalThis.navigator?.language) {
  if (units === 'f' || units === 'c') return units;
  return FAHRENHEIT_REGIONS.has(regionOf(locale)) ? 'f' : 'c';
}
export const windUnitOf = unit => (unit === 'f' ? 'mph' : 'km/h');

const coord = value => Math.round(Number(value) * 10_000) / 10_000;
const validPlace = place => !!place && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lon))
  && Math.abs(place.lat) <= 90 && Math.abs(place.lon) <= 180;

/** Forecast request: current conditions, 48 hours and 7 days, in the place's own time zone. */
export function forecastUrl(place, unit = 'c') {
  if (!validPlace(place)) throw new Error('Choose a place for the weather first.');
  const url = new URL(FORECAST_URL);
  const params = {
    latitude: coord(place.lat),
    longitude: coord(place.lon),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max',
    timezone: 'auto',
    timeformat: 'unixtime',
    forecast_days: 7,
    temperature_unit: unit === 'f' ? 'fahrenheit' : 'celsius',
    wind_speed_unit: unit === 'f' ? 'mph' : 'kmh',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.href;
}

/** Place search request (Open-Meteo geocoding), names in the interface language when it has them. */
export function geocodeUrl(query, { count = 6, language = 'en' } = {}) {
  const url = new URL(GEOCODING_URL);
  url.searchParams.set('name', String(query || '').trim().slice(0, 100));
  url.searchParams.set('count', String(count));
  url.searchParams.set('language', /^[a-z]{2}$/i.test(String(language).slice(0, 2)) ? String(language).slice(0, 2).toLowerCase() : 'en');
  url.searchParams.set('format', 'json');
  return url.href;
}

export function reverseUrl(lat, lon, { language = 'en' } = {}) {
  const url = new URL(REVERSE_URL);
  url.searchParams.set('latitude', String(coord(lat)));
  url.searchParams.set('longitude', String(coord(lon)));
  url.searchParams.set('localityLanguage', String(language).slice(0, 2).toLowerCase() || 'en');
  return url.href;
}

/** Cache key for a place's forecast in one unit (coordinates rounded to ~1 km). */
export function weatherCacheKey(place, unit) {
  return `weather:${Number(place.lat).toFixed(2)},${Number(place.lon).toFixed(2)}:${unit === 'f' ? 'f' : 'c'}`;
}

const text = (value, max = 120) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** A stored place from a geocoding result: { name, admin, country, lat, lon }, or null when unusable. */
export function normalizePlace(input) {
  if (!input || typeof input !== 'object') return null;
  const lat = Number(input.lat ?? input.latitude);
  const lon = Number(input.lon ?? input.longitude);
  const place = { name: text(input.name) || 'Unnamed place', admin: text(input.admin ?? input.admin1), country: text(input.country), lat: coord(lat), lon: coord(lon) };
  if (input.source === 'device') place.source = 'device';
  return validPlace(place) ? place : null;
}

/** "Aurora" / "Aurora, Colorado" (detail adds the country, for telling search results apart). */
export function placeLabel(place, { detail = false } = {}) {
  if (!place) return '';
  const parts = [place.name, detail ? place.admin : '', detail ? place.country : ''].filter(Boolean);
  return [...new Set(parts)].join(', ');
}

/** Geocoding results -> places, without duplicates (the same town can come back once per postcode). */
export function parsePlaces(json) {
  const seen = new Set();
  const out = [];
  for (const result of Array.isArray(json?.results) ? json.results : []) {
    const place = normalizePlace({ name: result.name, admin: result.admin1, country: result.country, lat: result.latitude, lon: result.longitude });
    if (!place) continue;
    const key = `${place.name}|${place.admin}|${place.country}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(place);
  }
  return out;
}

/** BigDataCloud reverse geocoding -> a place at the given coordinates (named "Current location" when unknown). */
export function parseReverse(json, lat, lon) {
  const name = text(json?.city) || text(json?.locality) || 'Current location';
  return normalizePlace({ name, admin: text(json?.principalSubdivision), country: text(json?.countryName), lat, lon, source: 'device' });
}

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const column = (block, key, index) => num(block?.[key]?.[index]);

/**
 * Normalizes an Open-Meteo forecast (unixtime format) into what the widget stores in its cache:
 * { tz, current: { temp, feels, humidity, code, wind, isDay, time }, hourly: [{ time, temp, code, pop, isDay }],
 *   daily: [{ time, code, max, min, sunrise, sunset, pop }] }. Hours before `now` (minus one) are dropped and at most
 * 48 are kept, so the cache stays small.
 */
export function parseForecast(json, now = Date.now()) {
  if (!json || typeof json !== 'object' || !json.current || !Array.isArray(json.hourly?.time) || !Array.isArray(json.daily?.time)) {
    throw weatherError('invalid', 'Open-Meteo sent a forecast Still could not read. Try again in a few minutes.');
  }
  const current = json.current;
  const nowSec = Math.floor(now / 1000);
  const hourly = [];
  json.hourly.time.forEach((time, index) => {
    if (typeof time !== 'number' || time < nowSec - 3600 || hourly.length >= 48) return;
    const temp = column(json.hourly, 'temperature_2m', index);
    if (temp === null) return;
    hourly.push({ time, temp, code: column(json.hourly, 'weather_code', index), pop: column(json.hourly, 'precipitation_probability', index),
      isDay: column(json.hourly, 'is_day', index) !== 0 });
  });
  const daily = json.daily.time.map((time, index) => ({
    time,
    code: column(json.daily, 'weather_code', index),
    max: column(json.daily, 'temperature_2m_max', index),
    min: column(json.daily, 'temperature_2m_min', index),
    sunrise: column(json.daily, 'sunrise', index),
    sunset: column(json.daily, 'sunset', index),
    pop: column(json.daily, 'precipitation_probability_max', index),
  })).filter(day => typeof day.time === 'number' && day.max !== null && day.min !== null).slice(0, 7);
  const temp = num(current.temperature_2m);
  if (temp === null) throw weatherError('invalid', 'Open-Meteo sent a forecast without a temperature. Try again in a few minutes.');
  return {
    tz: typeof json.timezone === 'string' ? json.timezone : 'UTC',
    current: {
      temp,
      feels: num(current.apparent_temperature) ?? temp,
      humidity: num(current.relative_humidity_2m),
      code: num(current.weather_code),
      wind: num(current.wind_speed_10m),
      isDay: num(current.is_day) !== 0,
      time: num(current.time) ?? nowSec,
    },
    hourly,
    daily,
  };
}

/** The next `count` hours starting with the current one. */
export function upcomingHours(forecast, now = Date.now(), count = 12) {
  const hourStart = Math.floor(now / 3_600_000) * 3600;
  return (forecast?.hourly || []).filter(hour => hour.time >= hourStart).slice(0, count);
}

/** Today's entry (the one whose day contains now), else the first. */
export function today(forecast, now = Date.now()) {
  const days = forecast?.daily || [];
  const nowSec = now / 1000;
  return days.findLast(day => day.time <= nowSec) || days[0] || null;
}

/**
 * Forecast days from today on (at most `count`), so a forecast cached yesterday still starts with today. Days are
 * keyed by their local midnight; a forecast whose last day has ended gives [].
 */
export function upcomingDays(forecast, now = Date.now(), count = 7) {
  const days = forecast?.daily || [];
  const nowSec = now / 1000;
  if (!days.length || days.at(-1).time + 86_400 <= nowSec) return [];
  const start = Math.max(0, days.findLastIndex(day => day.time <= nowSec));
  return days.slice(start, start + count);
}

/** Readings older than this give way to the forecast for the current hour. */
const CURRENT_MAX_AGE = 90 * 60;
/**
 * The current conditions to show: the cached reading, or, when it is more than 90 minutes old (a new tab painting an
 * old cache while offline), the forecast for this hour with the same feels-like difference. estimated marks the swap.
 */
export function currentConditions(forecast, now = Date.now()) {
  const current = forecast?.current;
  if (!current) return null;
  const nowSec = now / 1000;
  if (!Number.isFinite(current.time) || nowSec - current.time < CURRENT_MAX_AGE) return current;
  const hour = (forecast.hourly || []).findLast(h => h.time <= nowSec && nowSec - h.time < 3600);
  if (!hour) return current;
  const feelsDelta = Number.isFinite(current.feels) ? current.feels - current.temp : 0;
  return { ...current, temp: hour.temp, feels: hour.temp + feelsDelta, code: hour.code ?? current.code, isDay: hour.isDay, time: hour.time, estimated: true };
}

// ------------------------------------------------------------------ formatting

/** 66.4 -> "66°", -3.6 -> "−4°" (a real minus sign). */
export function formatTemp(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return '–';
  return `${n < 0 ? '−' : ''}${Math.abs(n)}°`;
}
export const unitLabel = unit => (unit === 'f' ? 'F' : 'C');
export function formatWind(value, unit) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? `${n} ${windUnitOf(unit)}` : '–';
}

const formatters = new Map();
function formatter(locale, options) {
  const key = `${locale || ''}|${JSON.stringify(options)}`;
  if (!formatters.has(key)) {
    let made;
    try { made = new Intl.DateTimeFormat(locale || undefined, options); } catch { made = new Intl.DateTimeFormat(undefined, { ...options, timeZone: undefined }); }
    formatters.set(key, made);
  }
  return formatters.get(key);
}
/** "3 PM" / "15" for an hour in the forecast's time zone. */
export function formatHour(unixSeconds, tz, locale) {
  return formatter(locale, { hour: 'numeric', timeZone: tz || undefined }).format(new Date(unixSeconds * 1000));
}
/** "6:42 AM" for sunrise and sunset in the forecast's time zone. */
export function formatClock(unixSeconds, tz, locale) {
  if (!Number.isFinite(unixSeconds)) return '–';
  return formatter(locale, { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined }).format(new Date(unixSeconds * 1000));
}
/** "Today" for the first day, else the short weekday ("Sat"), in the forecast's time zone. */
export function formatDay(unixSeconds, tz, locale, { first = false } = {}) {
  if (first) return 'Today';
  return formatter(locale, { weekday: 'short', timeZone: tz || undefined }).format(new Date(unixSeconds * 1000 + 12 * 3_600_000));
}
/** "Updated just now" / "Updated 5 min ago" / "Updated 2 hr ago". */
export function updatedLabel(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Updated ${hours} hr ago`;
  return `Updated ${Math.round(hours / 24)} days ago`;
}

// ------------------------------------------------------------------ network

/** Errors carry a kind: 'rate' (busy / limit), 'network', 'location', 'invalid' or 'http'. Messages say what to do. */
export function weatherError(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

async function getJson(url, { fetch: fetchImpl = globalThis.fetch, signal, service = 'Open-Meteo' } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { signal, credentials: 'omit', headers: { accept: 'application/json' } });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw weatherError('network', `Unable to reach ${service}. Check your connection and try again.`);
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.status === 429 || /limit exceeded/i.test(String(body?.reason || ''))) {
    throw weatherError('rate', `${service} is busy right now. Still will try again in a few minutes.`);
  }
  if (!response.ok || body?.error) {
    if (response.status === 400) throw weatherError('location', `${service} could not use this place. Choose it again in the widget settings.`);
    throw weatherError('http', `${service} could not send the weather (error ${response.status}). Try again in a few minutes.`);
  }
  if (!body || typeof body !== 'object') throw weatherError('invalid', `${service} sent a reply Still could not read. Try again in a few minutes.`);
  return body;
}

export async function fetchForecast(place, unit, options = {}) {
  return parseForecast(await getJson(forecastUrl(place, unit), options), options.now ?? Date.now());
}

export async function searchPlaces(query, { language, count = 6, ...options } = {}) {
  if (String(query || '').trim().length < 2) return [];
  return parsePlaces(await getJson(geocodeUrl(query, { count, language }), options));
}

export async function reversePlace(lat, lon, { language, ...options } = {}) {
  try {
    return parseReverse(await getJson(reverseUrl(lat, lon, { language }), { ...options, service: 'The place lookup' }), lat, lon);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    // The forecast only needs the coordinates; the place name is a nicety.
    return normalizePlace({ name: 'Current location', lat, lon, source: 'device' });
  }
}

/** A calm message for a geolocation error code (1 denied, 2 unavailable, 3 timeout). */
export function geolocationMessage(code) {
  if (code === 1) return 'Location access is off for Still. Search for a city instead, or allow location for Still in Chrome’s site settings.';
  if (code === 3) return 'Finding your location took too long. Try again, or search for a city.';
  return 'Your location is not available right now. Search for a city instead.';
}

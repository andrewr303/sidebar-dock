import test from 'node:test';
import assert from 'node:assert/strict';
import {
  weatherCondition, resolveUnit, regionOf, forecastUrl, geocodeUrl, reverseUrl, weatherCacheKey, normalizePlace, placeLabel, parsePlaces, parseReverse,
  parseForecast, upcomingHours, today, formatTemp, formatWind, updatedLabel, fetchForecast, searchPlaces, reversePlace, geolocationMessage,
  WEATHER_ORIGINS, LOCATE_ORIGINS,
} from '../extension/lib/weather.js';

const aurora = { name: 'Aurora', admin: 'Colorado', country: 'United States', lat: 39.7294, lon: -104.8319 };
const NOW = Date.UTC(2026, 9, 30, 18, 20); // 12:20 in Denver

function forecastJson() {
  const start = Date.UTC(2026, 9, 30, 12) / 1000;
  const hours = Array.from({ length: 72 }, (_, i) => start + i * 3600);
  const days = Array.from({ length: 7 }, (_, i) => Date.UTC(2026, 9, 30 + i, 6) / 1000);
  return {
    latitude: 39.73, longitude: -104.83, timezone: 'America/Denver', utc_offset_seconds: -21600,
    current: { time: NOW / 1000, temperature_2m: 66.4, apparent_temperature: 63.2, relative_humidity_2m: 41, weather_code: 2, wind_speed_10m: 7.6, is_day: 1 },
    hourly: { time: hours, temperature_2m: hours.map((_, i) => 60 + (i % 10)), weather_code: hours.map(() => 3), precipitation_probability: hours.map((_, i) => (i % 5) * 10), is_day: hours.map((_, i) => (i % 24 < 12 ? 1 : 0)) },
    daily: { time: days, weather_code: days.map(() => 61), temperature_2m_max: days.map((_, i) => 70 - i), temperature_2m_min: days.map((_, i) => 45 + i),
      sunrise: days.map(t => t + 3600), sunset: days.map(t => t + 40000), precipitation_probability_max: days.map((_, i) => i * 10) },
  };
}

test('WMO codes map to labels, kinds and day or night glyphs', () => {
  assert.deepEqual(weatherCondition(0, true), { code: 0, label: 'Clear', kind: 'clear', icon: 'wx-sun', tint: 'sun' });
  assert.equal(weatherCondition(0, false).icon, 'wx-moon');
  assert.equal(weatherCondition(0, 0).tint, 'moon');
  assert.equal(weatherCondition(2, true).icon, 'wx-cloud-sun');
  assert.equal(weatherCondition(1, false).icon, 'wx-cloud-moon');
  assert.equal(weatherCondition(3).icon, 'wx-cloud');
  assert.equal(weatherCondition(45).label, 'Fog');
  assert.equal(weatherCondition(55).icon, 'wx-drizzle');
  assert.equal(weatherCondition(63).icon, 'wx-rain');
  assert.equal(weatherCondition(81, true).icon, 'wx-showers-day');
  assert.equal(weatherCondition(81, false).icon, 'wx-showers-night');
  assert.equal(weatherCondition(66).icon, 'wx-sleet');
  assert.equal(weatherCondition(75).icon, 'wx-snow');
  assert.equal(weatherCondition(95).icon, 'wx-storm');
  assert.equal(weatherCondition(99).icon, 'wx-hail');
  assert.equal(weatherCondition(99).tint, 'storm');
  const unknown = weatherCondition(42);
  assert.equal(unknown.code, null);
  assert.equal(unknown.icon, 'wx-cloud');
  assert.equal(weatherCondition(null).label, 'Unknown conditions');
});

test('units follow the locale region unless chosen', () => {
  assert.equal(resolveUnit('auto', 'en-US'), 'f');
  assert.equal(resolveUnit('auto', 'en'), 'f');         // likely region US
  assert.equal(resolveUnit('auto', 'es-PR'), 'f');
  assert.equal(resolveUnit('auto', 'en-GB'), 'c');
  assert.equal(resolveUnit('auto', 'fr'), 'c');
  assert.equal(resolveUnit('auto', 'de-AT'), 'c');
  assert.equal(resolveUnit('c', 'en-US'), 'c');
  assert.equal(resolveUnit('f', 'de-DE'), 'f');
  assert.equal(regionOf('pt-BR'), 'BR');
  assert.equal(regionOf('not a locale!!'), '');
});

test('request URLs carry the fields, units and rounded coordinates', () => {
  const url = new URL(forecastUrl(aurora, 'f'));
  assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(url.searchParams.get('latitude'), '39.7294');
  assert.equal(url.searchParams.get('longitude'), '-104.8319');
  assert.equal(url.searchParams.get('temperature_unit'), 'fahrenheit');
  assert.equal(url.searchParams.get('wind_speed_unit'), 'mph');
  assert.equal(url.searchParams.get('timezone'), 'auto');
  assert.equal(url.searchParams.get('timeformat'), 'unixtime');
  for (const field of ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'weather_code', 'wind_speed_10m', 'is_day']) {
    assert.ok(url.searchParams.get('current').split(',').includes(field), field);
  }
  assert.ok(url.searchParams.get('hourly').includes('precipitation_probability'));
  assert.ok(url.searchParams.get('daily').includes('temperature_2m_max'));
  assert.ok(url.searchParams.get('daily').includes('sunrise'));
  const metric = new URL(forecastUrl({ lat: 1.234567, lon: 2 }, 'c'));
  assert.equal(metric.searchParams.get('temperature_unit'), 'celsius');
  assert.equal(metric.searchParams.get('wind_speed_unit'), 'kmh');
  assert.equal(metric.searchParams.get('latitude'), '1.2346');
  assert.throws(() => forecastUrl(null, 'c'), /Choose a place/);
  assert.throws(() => forecastUrl({ lat: 95, lon: 0 }, 'c'), /Choose a place/);

  const geo = new URL(geocodeUrl('  São Paulo ', { language: 'pt-BR' }));
  assert.equal(geo.origin, 'https://geocoding-api.open-meteo.com');
  assert.equal(geo.searchParams.get('name'), 'São Paulo');
  assert.equal(geo.searchParams.get('count'), '6');
  assert.equal(geo.searchParams.get('language'), 'pt');
  assert.equal(geo.searchParams.get('format'), 'json');
  assert.equal(new URL(geocodeUrl('x', { language: '!!' })).searchParams.get('language'), 'en');
  assert.match(reverseUrl(39.72941, -104.83192), /latitude=39\.7294&longitude=-104\.8319/);
  assert.deepEqual(WEATHER_ORIGINS.map(u => new URL(u).host), ['api.open-meteo.com', 'geocoding-api.open-meteo.com']);
  assert.equal(LOCATE_ORIGINS.length, 3);
});

test('cache keys round to about a kilometre and include the unit', () => {
  assert.equal(weatherCacheKey(aurora, 'f'), 'weather:39.73,-104.83:f');
  assert.equal(weatherCacheKey({ lat: 39.7312, lon: -104.8301 }, 'f'), 'weather:39.73,-104.83:f');
  assert.equal(weatherCacheKey(aurora, 'x'), 'weather:39.73,-104.83:c');
});

test('places normalize from geocoding results without duplicates', () => {
  const places = parsePlaces({ results: [
    { name: 'Aurora', admin1: 'Colorado', country: 'United States', latitude: 39.7294, longitude: -104.8319 },
    { name: 'Aurora', admin1: 'Colorado', country: 'United States', latitude: 39.73, longitude: -104.83 },
    { name: 'Aurora', admin1: 'Illinois', country: 'United States', latitude: 41.7606, longitude: -88.3201 },
    { name: 'Nowhere', latitude: 'x', longitude: 2 },
  ] });
  assert.equal(places.length, 2);
  assert.deepEqual(places[0], aurora);
  assert.deepEqual(parsePlaces({}), []);
  assert.equal(placeLabel(aurora), 'Aurora');
  assert.equal(placeLabel(aurora, { detail: true }), 'Aurora, Colorado, United States');
  assert.equal(placeLabel({ name: 'Singapore', admin: 'Singapore', country: 'Singapore' }, { detail: true }), 'Singapore');
  assert.equal(normalizePlace({ name: '', lat: 1, lon: 2 }).name, 'Unnamed place');
  assert.equal(normalizePlace({ name: 'x', lat: 200, lon: 0 }), null);
  assert.equal(normalizePlace(null), null);
  const here = parseReverse({ city: '', locality: 'Aurora', principalSubdivision: 'Colorado', countryName: 'United States' }, 39.7, -104.8);
  assert.equal(here.name, 'Aurora');
  assert.equal(here.source, 'device');
  assert.equal(parseReverse(null, 1, 2).name, 'Current location');
});

test('forecasts parse into current, upcoming hours and seven days', () => {
  const data = parseForecast(forecastJson(), NOW);
  assert.equal(data.tz, 'America/Denver');
  assert.equal(data.current.temp, 66.4);
  assert.equal(data.current.feels, 63.2);
  assert.equal(data.current.isDay, true);
  assert.equal(data.daily.length, 7);
  assert.ok(data.hourly.length <= 48);
  assert.ok(data.hourly[0].time >= NOW / 1000 - 3600);
  const hours = upcomingHours(data, NOW, 12);
  assert.equal(hours.length, 12);
  assert.equal(hours[0].time, Date.UTC(2026, 9, 30, 18) / 1000);
  assert.equal(today(data, NOW).max, 70);
  assert.equal(today(data, Date.UTC(2026, 10, 1, 12)).max, 68);
  assert.throws(() => parseForecast({ current: {} }), /could not read/);
  const missing = forecastJson();
  missing.current.temperature_2m = null;
  assert.throws(() => parseForecast(missing, NOW), /without a temperature/);
});

test('temperatures, wind and update times format for people', () => {
  assert.equal(formatTemp(66.4), '66°');
  assert.equal(formatTemp(-3.6), '−4°');
  assert.equal(formatTemp(-0.2), '0°');
  assert.equal(formatTemp(undefined), '–');
  assert.equal(formatWind(7.6, 'f'), '8 mph');
  assert.equal(formatWind(12.2, 'c'), '12 km/h');
  assert.equal(updatedLabel(NOW - 20_000, NOW), 'Updated just now');
  assert.equal(updatedLabel(NOW - 5 * 60_000, NOW), 'Updated 5 min ago');
  assert.equal(updatedLabel(NOW - 3 * 3_600_000, NOW), 'Updated 3 hr ago');
  assert.equal(updatedLabel(NaN, NOW), '');
  assert.match(geolocationMessage(1), /Location access is off/);
  assert.match(geolocationMessage(3), /took too long/);
  assert.match(geolocationMessage(2), /not available/);
});

test('fetches map service errors to calm, actionable messages', async () => {
  const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
  const data = await fetchForecast(aurora, 'f', { fetch: reply(200, forecastJson()), now: NOW });
  assert.equal(data.current.temp, 66.4);
  await assert.rejects(fetchForecast(aurora, 'f', { fetch: reply(429, { error: true, reason: 'Daily API request limit exceeded' }) }), e => e.kind === 'rate' && /busy/.test(e.message));
  await assert.rejects(fetchForecast(aurora, 'f', { fetch: reply(400, { error: true, reason: 'Latitude must be in range' }) }), e => e.kind === 'location');
  await assert.rejects(fetchForecast(aurora, 'f', { fetch: reply(503, null) }), e => e.kind === 'http' && /503/.test(e.message));
  await assert.rejects(fetchForecast(aurora, 'f', { fetch: async () => { throw new TypeError('Failed to fetch'); } }), e => e.kind === 'network' && /connection/.test(e.message));
  assert.deepEqual(await searchPlaces('a', { fetch: () => assert.fail('no request for one letter') }), []);
  const found = await searchPlaces('Aurora', { fetch: reply(200, { results: [{ name: 'Aurora', admin1: 'Colorado', country: 'United States', latitude: 39.7294, longitude: -104.8319 }] }) });
  assert.equal(found[0].name, 'Aurora');
  const fallback = await reversePlace(39.7, -104.8, { fetch: async () => { throw new TypeError('offline'); } });
  assert.equal(fallback.name, 'Current location');
  assert.equal(fallback.source, 'device');
});

// Virtual CH 3 — a generated local-weather barker channel. Renders a
// deterministic synthetic forecast immediately (so there's never a blank/
// loading moment), then — if a real lat/lon is set (config.eas.lat/lon,
// shared with the NOAA Weather & EAS plugin) and the box isn't in
// time-machine mode — kicks off a real api.weather.gov lookup via the
// already core-exposed window.api.noaaGetForecast and swaps the display
// over to it if it resolves before the user tunes away. Migrated as-is
// from the old core weather.js/virtual.js.
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

// mulberry32 — small, fast, deterministic PRNG from a 32-bit seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayIndex(dateMs) {
  return Math.floor(dateMs / 86400000);
}

const MONTH_BASE_TEMP = [32, 36, 45, 55, 65, 74, 80, 78, 70, 58, 46, 35];
const CONDITIONS_WARM = [
  { name: 'CLEAR', weight: 4 }, { name: 'PARTLY CLOUDY', weight: 4 },
  { name: 'CLOUDY', weight: 2 }, { name: 'RAIN', weight: 2 }, { name: 'T-STORMS', weight: 1 },
];
const CONDITIONS_COLD = [
  { name: 'CLEAR', weight: 3 }, { name: 'PARTLY CLOUDY', weight: 3 },
  { name: 'CLOUDY', weight: 3 }, { name: 'SNOW', weight: 2 }, { name: 'RAIN', weight: 1 },
];

function pickCondition(rand, month) {
  const list = MONTH_BASE_TEMP[month] <= 42 ? CONDITIONS_COLD : CONDITIONS_WARM;
  const total = list.reduce((s, c) => s + c.weight, 0);
  let r = rand() * total;
  for (const c of list) {
    if (r < c.weight) return c.name;
    r -= c.weight;
  }
  return list[0].name;
}

function tempForDay(locationSeed, dIdx, month) {
  const rand = mulberry32((locationSeed + dIdx * 2654435761) >>> 0);
  const base = MONTH_BASE_TEMP[month];
  return Math.round(base + (rand() - 0.5) * 24);
}

function generateWeather(dateMs, location) {
  const locationSeed = hashString(location || 'ANYTOWN, USA');
  const dIdx = dayIndex(dateMs);
  const d = new Date(dateMs);
  const month = d.getMonth();
  const rand = mulberry32((locationSeed + dIdx) >>> 0);

  const tempF = tempForDay(locationSeed, dIdx, month);
  const condition = pickCondition(rand, month);
  const high = tempF + 3 + Math.round(rand() * 4);
  const low = tempF - 6 - Math.round(rand() * 4);

  const forecast = [];
  for (let i = 1; i <= 3; i++) {
    const fDate = new Date(dateMs + i * 86400000);
    const fMonth = fDate.getMonth();
    const fRand = mulberry32((locationSeed + dIdx + i) >>> 0);
    const fTemp = tempForDay(locationSeed, dIdx + i, fMonth);
    forecast.push({
      date: fDate,
      condition: pickCondition(fRand, fMonth),
      high: fTemp + 3 + Math.round(fRand() * 4),
      low: fTemp - 6 - Math.round(fRand() * 4),
    });
  }

  return { condition, tempF, high, low, forecast };
}

function popValue(period) {
  return period && period.probabilityOfPrecipitation && period.probabilityOfPrecipitation.value != null
    ? period.probabilityOfPrecipitation.value : null;
}

// Maps api.weather.gov's /forecast periods into the same shape
// generateWeather() returns, so applyData() can use either without caring
// which one produced it. Only meaningful for *now* — callers fall back to
// the synthetic generator in time-machine mode. Beyond the original
// condition/temp/high/low, also carries wind + chance-of-precip + NWS's own
// prose forecast — the synthetic generator has no equivalent for these
// (nothing to model them on), so applyData() only renders this "detail" row
// when a real NOAA lookup actually supplied it.
function mapNoaaPeriods(periods) {
  if (!periods || !periods.length) return null;
  const first = periods[0];
  const second = periods[1];
  const tempF = first.temperature;
  const high = first.isDaytime ? first.temperature : (second ? Math.max(first.temperature, second.temperature) : first.temperature);
  const low = first.isDaytime ? (second ? second.temperature : first.temperature) : first.temperature;
  const condition = (first.shortForecast || '').toUpperCase();
  const wind = first.windSpeed ? `${first.windDirection || ''} ${first.windSpeed}`.trim() : null;
  const pop = popValue(first);
  const detailedForecast = first.detailedForecast || null;

  const rest = periods.slice(first.isDaytime ? 2 : 1);
  const forecast = [];
  for (let i = 0; i < rest.length - 1 && forecast.length < 3; i += 2) {
    const day = rest[i];
    const night = rest[i + 1];
    if (!day || !day.isDaytime) continue;
    forecast.push({
      date: new Date(day.startTime),
      condition: (day.shortForecast || '').toUpperCase(),
      high: day.temperature,
      low: night ? night.temperature : day.temperature,
      pop: popValue(day),
    });
  }
  return { condition, tempF, high, low, forecast, wind, pop, detailedForecast };
}

let currentContainer = null;
let currentCtx = null; // set in render() — applyData() has no ctx param of its own, needs ctx.WEEKDAYS
let clockTimer = null;

// Sets the header location line — called with the free-text config value up
// front (render(), so there's never a blank moment) and again with NWS's own
// resolved place name once/if a real forecast lookup lands, same
// upgrade-in-place pattern applyData() uses for the readout itself.
function applyLocationText(text) {
  if (!currentContainer) return;
  currentContainer.querySelector('[data-el="location"]').textContent = text;
}

// Forecasts are produced in °F and mph (the NWS and the generator both are);
// SETTINGS › Plug-ins › Local weather can show °C and km/h instead.
function metric() {
  return !!(window.S && window.S.config.weather && window.S.config.weather.units === 'C');
}
function temp(f) { return metric() ? Math.round((f - 32) * 5 / 9) : f; }
function windText(text) {
  return metric()
    ? String(text).replace(/(\d+)/g, (m) => String(Math.round(Number(m) * 1.609))).replace(/mph/i, 'km/h')
    : text;
}

function applyData(w, isLive) {
  if (!currentContainer) return;
  currentContainer.querySelector('[data-el="source"]').classList.toggle('hidden', !isLive);
  currentContainer.querySelector('[data-el="condition"]').textContent = w.condition;
  currentContainer.querySelector('[data-el="temp"]').textContent = `${temp(w.tempF)}°${metric() ? 'C' : 'F'}`;
  currentContainer.querySelector('[data-el="high"]').textContent = `${temp(w.high)}°`;
  currentContainer.querySelector('[data-el="low"]').textContent = `${temp(w.low)}°`;

  // Wind/chance-of-precip/NWS prose only exist on a real forecast — hidden
  // for the synthetic generator, which has nothing to put here.
  const detailEl = currentContainer.querySelector('[data-el="detail"]');
  const descEl = currentContainer.querySelector('[data-el="description"]');
  const detailParts = [];
  if (w.wind) detailParts.push(`WIND ${windText(w.wind)}`);
  if (w.pop != null) detailParts.push(`${w.pop}% CHANCE OF PRECIP`);
  detailEl.textContent = detailParts.join('   ·   ');
  detailEl.classList.toggle('hidden', detailParts.length === 0);
  descEl.textContent = w.detailedForecast || '';
  descEl.classList.toggle('hidden', !w.detailedForecast);

  const forecastEl = currentContainer.querySelector('[data-el="forecast"]');
  forecastEl.innerHTML = '';
  w.forecast.forEach((f) => {
    const card = document.createElement('div');
    card.className = 'weather-forecast-day';
    const day = document.createElement('div');
    day.className = 'wfd-day';
    day.textContent = currentCtx.WEEKDAYS[f.date.getDay()].slice(0, 3);
    const cond = document.createElement('div');
    cond.className = 'wfd-cond';
    cond.textContent = f.condition;
    const hilo = document.createElement('div');
    hilo.className = 'wfd-hilo';
    hilo.textContent = `${temp(f.high)}° / ${temp(f.low)}°`;
    card.appendChild(day);
    card.appendChild(cond);
    card.appendChild(hilo);
    if (f.pop != null) {
      const pop = document.createElement('div');
      pop.className = 'wfd-pop';
      pop.textContent = `${f.pop}% RAIN`;
      card.appendChild(pop);
    }
    forecastEl.appendChild(card);
  });
}

function updateClock(ctx) {
  if (!currentContainer) return;
  const d = new Date(ctx.viewNow());
  currentContainer.querySelector('[data-el="clock"]').textContent = ctx.formatClock(d);
  currentContainer.querySelector('[data-el="date"]').textContent = `${ctx.WEEKDAYS[d.getDay()]} · ${ctx.MONTHS[d.getMonth()]} ${d.getDate()}`;
}

window.RCBPlugins.registerChannelType('local-weather', {
  number: 3,
  label: 'WEATHER',
  nowText: 'Local Forecast',
  badge: { bg: '#38bdf8', label: 'WX' },
  render(container, ctx) {
    currentContainer = container;
    currentCtx = ctx;
    const location = (ctx.S.config.weather && ctx.S.config.weather.location) || 'ANYTOWN, USA';
    container.innerHTML = `
      <div class="weather-channel">
        <div class="weather-header">
          <div class="weather-brand">LOCAL WEATHER</div>
          <div class="weather-clockbox">
            <div class="weather-clock" data-el="clock">--:--</div>
            <div class="weather-date" data-el="date"></div>
          </div>
        </div>
        <div class="weather-body">
          <div class="weather-location" data-el="location"></div>
          <div class="weather-source hidden" data-el="source">● LIVE NOAA DATA</div>
          <div class="weather-now">
            <div class="weather-condition" data-el="condition"></div>
            <div class="weather-temp" data-el="temp"></div>
          </div>
          <div class="weather-hilo">
            <span>HIGH <span data-el="high"></span></span>
            <span>LOW <span data-el="low"></span></span>
          </div>
          <div class="weather-detail hidden" data-el="detail"></div>
          <div class="weather-description hidden" data-el="description"></div>
        </div>
        <div class="weather-forecast" data-el="forecast"></div>
      </div>
    `;

    applyLocationText(location);
    applyData(generateWeather(ctx.viewNow(), location));
    updateClock(ctx);
    clockTimer = setInterval(() => updateClock(ctx), 1000);

    // Background audio loop — same "resolve the file URL, bail if tuned
    // away before it resolves" pattern core's playVirtualAudio uses for
    // landing/public-access, just this channel's own config slice.
    const audioPath = ctx.S.config.weather && ctx.S.config.weather.audio;
    if (audioPath) {
      window.api.toFileUrl(audioPath).then((url) => {
        if (currentContainer !== container) return; // tuned away while resolving
        ctx.player.src = url;
        ctx.player.loop = true;
        ctx.player.play().catch(() => {});
      });
    }

    const { lat, lon } = ctx.S.config.eas || {};
    if (ctx.S.timeMachineOn || lat == null || lon == null) return;
    window.api.noaaGetForecast({ lat, lon }).then(({ periods, location: resolvedLocation }) => {
      if (currentContainer !== container || !ctx.S.isPoweredOn || ctx.S.timeMachineOn) return; // tuned away or mode changed while resolving
      const real = mapNoaaPeriods(periods);
      if (real) applyData(real, true);
      // NWS's own resolved place name replaces the free-text config value
      // once a real lookup lands — the free text is just a seed for the
      // deterministic synthetic forecast (and the offline/time-machine
      // fallback label), not something geocoded.
      if (resolvedLocation) applyLocationText(`${resolvedLocation.city.toUpperCase()}, ${resolvedLocation.state}`);
    }).catch(() => {});
  },
  stop() {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    currentContainer = null;
    currentCtx = null;
  },
});

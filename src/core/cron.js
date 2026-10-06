// Five-field local calendar cron, shared by the desktop scheduler and preview.
// Date is available in txiki.js; Intl and third-party cron runtimes are not.
const MINUTE = 60000, DAY = 86400000;
const ALIASES = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@midnight': '0 0 * * *' };
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const LIMITS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const fail = () => { throw new Error('Geçerli bir cron ifadesi gir: dakika saat ayın-günü ay haftanın-günü.'); };
function field(text, index) {
  const [min, max] = LIMITS[index];
  const values = new Set(), pieces = [];
  const number = input => {
    if (!/^\d+$/.test(input)) fail();
    const value = Number(input);
    if (!Number.isInteger(value) || value < min || value > max) fail();
    return value;
  };
  for (const item of text.split(',')) {
    const match = item.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!match) fail();
    const operand = match[1], step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isInteger(step) || step < 1 || step > 2147483647) fail();
    let start, end, canonical;
    if (operand === '*') { start = min; end = max; canonical = '*'; }
    else if (operand.includes('-')) {
      const range = operand.split('-').map(number); [start, end] = range;
      if (end < start) fail();
      canonical = `${start}-${end}`;
    } else { start = number(operand); end = match[2] === undefined ? start : max; canonical = String(start); }
    for (let value = start; value <= end; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    pieces.push(canonical + (match[2] === undefined ? '' : '/' + step));
  }
  return { values: [...values].sort((a, b) => a - b), expression: pieces.join(','), star: text.startsWith('*') };
}
const cache = new Map();
export function parseCron(expression) {
  if (typeof expression !== 'string' || expression.length > 256) fail();
  let source = expression.trim().toUpperCase();
  source = ALIASES[source.toLowerCase()] ?? source;
  const cached = cache.get(source);
  if (cached) return cached;
  const tokens = source.split(/\s+/);
  if (tokens.length !== 5) fail();
  tokens[3] = tokens[3].replace(/[A-Z]+/g, (name, atPosition, text) => { if ((atPosition && ![',', '-'].includes(text[atPosition - 1])) || (text[atPosition + name.length] && ![',', '-', '/'].includes(text[atPosition + name.length]))) fail(); const at = MONTHS.indexOf(name); if (at < 0) fail(); return String(at + 1); });
  tokens[4] = tokens[4].replace(/[A-Z]+/g, (name, atPosition, text) => { if ((atPosition && ![',', '-'].includes(text[atPosition - 1])) || (text[atPosition + name.length] && ![',', '-', '/'].includes(text[atPosition + name.length]))) fail(); const at = WEEKDAYS.indexOf(name); if (at < 0) fail(); return String(at); });
  const fields = tokens.map(field);
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = fields.map(value => value.values);
  const dayOfMonthStar = fields[2].star, dayOfWeekStar = fields[4].star;
  // Feasibility is a calendar property, independent of today's year. February
  // can contain 29 days, and every valid date attains every weekday eventually.
  const monthMaxima = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if ((dayOfMonthStar || dayOfWeekStar) && !months.some(month => daysOfMonth.some(day => day <= monthMaxima[month - 1])))
    throw new Error('Cron ifadesinde mümkün olmayan bir tarih var.');
  const times = hours.flatMap(hour => minutes.map(minute => hour * 60 + minute));
  const parsed = Object.freeze({ expression: fields.map(value => value.expression).join(' '),
    minutes: Object.freeze(minutes), hours: Object.freeze(hours), daysOfMonth: Object.freeze(daysOfMonth),
    months: Object.freeze(months), daysOfWeek: Object.freeze(daysOfWeek), dayOfMonthStar, dayOfWeekStar,
    times: Object.freeze(times) });
  if (cache.size >= 100) cache.delete(cache.keys().next().value);
  cache.set(source, parsed);
  return parsed;
}
const parsedCron = value => typeof value === 'string' ? parseCron(value) : value;
function matchesDate(rule, date) {
  if (!rule.months.includes(date.getMonth() + 1)) return false;
  const dom = rule.daysOfMonth.includes(date.getDate()), dow = rule.daysOfWeek.includes(date.getDay());
  return rule.dayOfMonthStar || rule.dayOfWeekStar ? dom && dow : dom || dow;
}
// Offset candidates include both sides of a DST transition, including 30-minute
// folds. Constructing an epoch for each offset also lets a repeated wall minute
// run twice, while verifying Date's fields excludes nonexistent gap minutes.
function dayOffsets(date) {
  const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTime();
  const offsets = new Set();
  for (let hour = -36; hour <= 36; hour += 6) offsets.add(new Date(noon + hour * 3600000).getTimezoneOffset());
  return [...offsets];
}
function upperBound(sorted, value) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const middle = (lo + hi) >>> 1; if (sorted[middle] <= value) lo = middle + 1; else hi = middle; }
  return lo;
}
function validWall(epoch, date, minute) {
  const value = new Date(epoch);
  return value.getFullYear() === date.getFullYear() && value.getMonth() === date.getMonth() && value.getDate() === date.getDate() &&
    value.getHours() * 60 + value.getMinutes() === minute && value.getSeconds() === 0;
}
function onDate(rule, date, boundary, forward) {
  const civilMidnight = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  let best = null;
  for (const offset of dayOffsets(date)) {
    const wallBoundary = Math.floor((boundary - offset * MINUTE - civilMidnight) / MINUTE);
    let index = forward ? upperBound(rule.times, wallBoundary) : upperBound(rule.times, wallBoundary) - 1;
    for (; index >= 0 && index < rule.times.length; index += forward ? 1 : -1) {
      const minute = rule.times[index], epoch = civilMidnight + (minute + offset) * MINUTE;
      if ((forward ? epoch > boundary : epoch <= boundary) && validWall(epoch, date, minute)) {
        if (best === null || (forward ? epoch < best : epoch > best)) best = epoch;
        break;
      }
    }
  }
  return best;
}

export function nextCronAfter(expression, after) {
  if (!Number.isFinite(after) || !Number.isFinite(new Date(after).getTime())) throw new Error('Geçerli bir zaman seç.');
  const rule = parsedCron(expression), base = new Date(after);
  // The Gregorian calendar (including weekdays) repeats every 400 years.
  // Star-prefixed weekday restrictions can leave 28- or 40-year leap-day gaps,
  // so shorter horizons reject valid schedules even though calendar dates exist.
  const lastDay = Date.UTC(base.getFullYear() + 400, base.getMonth(), base.getDate());
  for (let offset = 0; offset <= 400 * 366 + 2; offset++) {
    const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, 12);
    if (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) > lastDay) break;
    if (!matchesDate(rule, date)) continue;
    const due = onDate(rule, date, after, true);
    if (due !== null) return due;
  }
  throw new Error('Cron için Gregoryen takvim döngüsünde bir sonraki hatırlatma bulunamadı.');
}

export function latestCronDue(expression, firstDue, now) {
  if (firstDue === null || firstDue > now) return null;
  const rule = parsedCron(expression), boundary = Math.max(firstDue - 1, now - DAY), base = new Date(now);
  let latest = null;
  // At most three local calendar dates occur within 24 elapsed hours around DST.
  for (let offset = -2; offset <= 0; offset++) {
    const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, 12);
    if (!matchesDate(rule, date)) continue;
    const due = onDate(rule, date, now, false);
    if (due !== null && due > boundary && (latest === null || due > latest)) latest = due;
  }
  return latest;
}

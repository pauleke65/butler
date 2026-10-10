/** Timezone helpers built on Intl (no extra deps). All "wall clock" work happens in the household timezone. */

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export function weekdayName(index: number): string {
  return WEEKDAYS[((index % 7) + 7) % 7] as string;
}

export function wallClock(instant: Date, tz: string): WallClock {
  const parts = formatter(tz).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: Math.max(0, SHORT_WEEKDAYS.indexOf(get("weekday"))),
  };
}

/** Offset (minutes east of UTC) of `tz` at the given instant. */
export function tzOffsetMinutes(instant: Date, tz: string): number {
  const w = wallClock(instant, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** Convert a wall-clock time in `tz` to an instant (handles DST by iterating on the offset). */
export function zonedToInstant(
  c: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  tz: string,
): Date {
  const naive = Date.UTC(c.year, c.month - 1, c.day, c.hour ?? 0, c.minute ?? 0, c.second ?? 0);
  let guess = naive;
  for (let i = 0; i < 3; i++) {
    const offset = tzOffsetMinutes(new Date(guess), tz);
    const next = naive - offset * 60000;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

function pad(n: number, width = 2): string {
  return String(Math.abs(n)).padStart(width, "0");
}

/** ISO 8601 with the tz's offset, e.g. 2026-10-16T19:00:00-04:00 (contracts §1). */
export function isoInTz(instant: Date, tz: string): string {
  const w = wallClock(instant, tz);
  const off = tzOffsetMinutes(instant, tz);
  const sign = off < 0 ? "-" : "+";
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

export function startOfDayInTz(instant: Date, tz: string): Date {
  const w = wallClock(instant, tz);
  return zonedToInstant({ year: w.year, month: w.month, day: w.day }, tz);
}

export function addDays(instant: Date, days: number, tz: string): Date {
  const w = wallClock(instant, tz);
  return zonedToInstant({ year: w.year, month: w.month, day: w.day + days, hour: w.hour, minute: w.minute, second: w.second }, tz);
}

function dayNumber(instant: Date, tz: string): number {
  const w = wallClock(instant, tz);
  return Math.floor(Date.UTC(w.year, w.month - 1, w.day) / 86_400_000);
}

/** "7 PM" / "7:30 PM" (contracts §15). */
export function spokenTime(instant: Date, tz: string): string {
  const w = wallClock(instant, tz);
  const suffix = w.hour >= 12 ? "PM" : "AM";
  const h = w.hour % 12 === 0 ? 12 : w.hour % 12;
  return w.minute === 0 ? `${h} ${suffix}` : `${h}:${pad(w.minute)} ${suffix}`;
}

/** "today", "tomorrow", "Friday" within a week, "next Friday" the week after, otherwise "October 16". */
export function spokenDay(instant: Date, now: Date, tz: string): string {
  const diff = dayNumber(instant, tz) - dayNumber(now, tz);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  const w = wallClock(instant, tz);
  if (diff > 1 && diff < 7) return weekdayName(w.weekday);
  if (diff >= 7 && diff < 14) return `next ${weekdayName(w.weekday)}`;
  return `${MONTHS[w.month - 1]} ${w.day}`;
}

/** "Thursday to Sunday" / "next Thursday to Sunday": ranges are named by weekday when close, else by date. */
export function spokenRange(start: Date, end: Date, now: Date, tz: string): string {
  const startDiff = dayNumber(start, tz) - dayNumber(now, tz);
  const span = dayNumber(end, tz) - dayNumber(start, tz);
  const ws = wallClock(start, tz);
  const we = wallClock(end, tz);
  const first =
    startDiff >= 0 && startDiff < 7 ? weekdayName(ws.weekday)
      : startDiff >= 7 && startDiff < 14 ? `next ${weekdayName(ws.weekday)}`
        : `${MONTHS[ws.month - 1]} ${ws.day}`;
  if (span <= 0) return first;
  const last = span < 7 && startDiff >= 0 && startDiff < 14 ? weekdayName(we.weekday) : `${MONTHS[we.month - 1]} ${we.day}`;
  return `${first} to ${last}`;
}

/** "Friday at 7 PM". */
export function spokenWhen(instant: Date, now: Date, tz: string): string {
  return `${spokenDay(instant, now, tz)} at ${spokenTime(instant, tz)}`;
}

const NUMBER_WORDS =["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

export function numberWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? (NUMBER_WORDS[n] as string) : String(n);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "42 dollars" / "42 dollars 50" (contracts §15). Input is integer minor units. */
export function spokenMoney(amountMinor: number): string {
  const sign = amountMinor < 0 ? "minus " : "";
  const abs = Math.abs(Math.round(amountMinor));
  const dollars = Math.floor(abs / 100);
  const cents = abs % 100;
  const unit = dollars === 1 ? "dollar" : "dollars";
  return cents === 0 ? `${sign}${dollars} ${unit}` : `${sign}${dollars} ${unit} ${cents}`;
}

/** UTC ISO string in the Python store's style (`+00:00`, no millis) so GSI sort keys compare lexicographically. */
export function toUtcIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** Weekday name within the next week (even for today/tomorrow), otherwise "October 16". Used for ranges. */
export function spokenWeekdayOrDate(instant: Date, now: Date, tz: string): string {
  const diff = dayNumber(instant, tz) - dayNumber(now, tz);
  const w = wallClock(instant, tz);
  if (diff >= 0 && diff < 7) return weekdayName(w.weekday);
  return `${MONTHS[w.month - 1]} ${w.day}`;
}

import type { Money } from "@butler/contracts";

export function fmtMoney(m: Money | undefined): string {
  if (!m) return "";
  const dollars = m.amount_minor / 100;
  const whole = Number.isInteger(dollars);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency, minimumFractionDigits: whole ? 0 : 2 }).format(dollars);
}

export function fmtDate(iso: string | undefined, tz?: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { ...opts, ...(tz ? { timeZone: tz } : {}) }).format(d);
}

/** "Fri 7 PM" in the household/host timezone. */
export function fmtWhen(iso: string | undefined, tz?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opt = tz ? { timeZone: tz } : {};
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", ...opt }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", ...opt }).format(d).replace(":00", "");
  return `${day} ${time}`;
}

export function fmtTime(iso: string | undefined, tz?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", ...(tz ? { timeZone: tz } : {}) }).format(d);
}

export function shortDay(iso: string | undefined, tz?: string): string {
  return fmtDate(iso, tz, { weekday: "short", day: "numeric", month: "short" });
}

/**
 * Plan times are written with the household's UTC offset ("2026-10-16T19:00:00-04:00"). Show them on that clock, not
 * the viewer's: a Friday 7 PM dinner in New York must not read "Sat 12 AM" on a device set to Lagos.
 */
function onOwnClock(iso: string | undefined): { iso: string | undefined; tz: string | undefined } {
  const m = iso ? /([+-])(\d{2}):?(\d{2})$/.exec(iso) : null;
  if (!iso || !m) return { iso, tz: undefined };
  const offset = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const shifted = new Date(new Date(iso).getTime() + offset * 60_000);
  return Number.isNaN(shifted.getTime()) ? { iso, tz: undefined } : { iso: shifted.toISOString(), tz: "UTC" };
}

export function planWhen(starts?: string, ends?: string, tz?: string): string {
  if (!starts) return "";
  const a = onOwnClock(starts);
  const b = onOwnClock(ends);
  const ta = a.tz ?? tz;
  const tb = b.tz ?? tz;
  if (ends && fmtDate(a.iso, ta) !== fmtDate(b.iso, tb)) {
    return `${fmtDate(a.iso, ta, { weekday: "short", day: "numeric", month: "short" })} to ${fmtDate(b.iso, tb, { weekday: "short", day: "numeric", month: "short" })}`;
  }
  return fmtWhen(a.iso, ta);
}

export const TOOL_LABEL: Record<string, string> = {
  Messages___send_email: "Email",
  Calendar___create_event: "Calendar",
  Calendar___update_event: "Calendar",
  Calendar___delete_event: "Calendar",
  Calendar___list_events: "Calendar",
  Supplies___checkout: "Purchase",
  Supplies___refund: "Refund",
  Supplies___search_products: "Search",
  Services___book_service: "Booking",
  Services___cancel_booking: "Cancellation",
  Services___search_providers: "Search",
  Context___get_weather: "Weather",
};

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

export function planWhen(starts?: string, ends?: string, tz?: string): string {
  if (!starts) return "";
  if (ends && fmtDate(starts, tz) !== fmtDate(ends, tz)) {
    return `${fmtDate(starts, tz, { weekday: "short", day: "numeric", month: "short" })} to ${fmtDate(ends, tz, { weekday: "short", day: "numeric", month: "short" })}`;
  }
  return fmtWhen(starts, tz);
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

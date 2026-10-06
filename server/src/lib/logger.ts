export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  log(level: LogLevel, msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured JSON-lines logger (stderr so stdout stays clean for tooling). */
export function createLogger(opts: { level?: LogLevel; base?: LogFields; sink?: (line: string) => void } = {}): Logger {
  const min = ORDER[opts.level ?? "info"];
  const base = opts.base ?? {};
  const sink = opts.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const make = (fields: LogFields): Logger => ({
    log(level, msg, extra) {
      if (ORDER[level] < min) return;
      sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields, ...extra }));
    },
    child: (more) => make({ ...fields, ...more }),
  });
  return make(base);
}

export interface CapturedLog {
  level: LogLevel;
  msg: string;
  fields: LogFields;
}

/** Test logger that records every entry. */
export function createCapturingLogger(): Logger & { entries: CapturedLog[] } {
  const entries: CapturedLog[] = [];
  const make = (fields: LogFields): Logger => ({
    log(level, msg, extra) {
      entries.push({ level, msg, fields: { ...fields, ...extra } });
    },
    child: (more) => make({ ...fields, ...more }),
  });
  return Object.assign(make({}), { entries });
}

export const silentLogger: Logger = {
  log() {},
  child() {
    return silentLogger;
  },
};

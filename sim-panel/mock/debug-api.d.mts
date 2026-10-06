export function ulid(ts?: number): string;
export function defaultRules(now?: number): Array<Record<string, unknown>>;
export function makeReceipt(o?: Record<string, unknown>): Record<string, unknown> & { action_id: string };
export function createMockDebugApi(o?: { token?: string; port?: number; demo?: boolean; log?: (l: string) => void }): {
  listen(): Promise<number>;
  close(): Promise<void>;
  reset(): void;
  readonly receipts: Array<Record<string, unknown>>;
  readonly rules: Array<Record<string, unknown>>;
};

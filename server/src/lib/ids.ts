/**
 * ULID-style ids with a type prefix (contracts §1). Mirrors libs/butler_actions/ids.py, but monotonic
 * within the process so ids created in the same millisecond still sort in creation order
 * (needs are ordered by `need_id`).
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RANDOM_BITS = 80n;
const RANDOM_MASK = (1n << RANDOM_BITS) - 1n;

function encode(value: bigint, length: number): string {
  let v = value;
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    out.push(ALPHABET[Number(v & 31n)] as string);
    v >>= 5n;
  }
  return out.reverse().join("");
}

function randomBig(): bigint {
  return BigInt(`0x${randomBytes(10).toString("hex")}`);
}

export type IdPrefix = "hh" | "mem" | "c" | "plan" | "need" | "dec" | "opt" | "act" | "rule" | "ord" | "bkg" | "evt" | "cor";
export type NewId = (prefix: IdPrefix) => string;

/** Create an id generator. `nowMs` supplies the timestamp part (pinned clocks keep ids time-ordered). */
export function makeIdGenerator(nowMs: () => number = () => Date.now()): NewId {
  let lastTs = -1;
  let lastRandom = 0n;
  return (prefix) => {
    let ts = nowMs();
    let rand: bigint;
    if (ts <= lastTs) {
      ts = lastTs;
      rand = (lastRandom + 1n) & RANDOM_MASK;
    } else {
      rand = randomBig();
    }
    lastTs = ts;
    lastRandom = rand;
    return `${prefix}_${encode(BigInt(ts), 10)}${encode(rand, 16)}`;
  };
}

export function ulid(tsMs: number = Date.now()): string {
  return `${encode(BigInt(tsMs), 10)}${encode(randomBig(), 16)}`;
}

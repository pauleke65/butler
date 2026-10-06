/** In-memory `Table` with DynamoDB semantics (single table + GSI1) for tests and offline demos. */
import { TableRepo, type Item, type QuerySpec, type Repo, type Table, type TableRepoOptions } from "./repo.js";

export class MemoryTable implements Table {
  readonly items = new Map<string, Item>();

  private key(pk: string, sk: string): string {
    return `${pk}\u0000${sk}`;
  }

  async put(item: Item, cond: { ifNotExists?: boolean; ifDataEquals?: string } = {}): Promise<boolean> {
    const existing = this.items.get(this.key(item.PK, item.SK));
    if (cond.ifNotExists && existing) return false;
    if (cond.ifDataEquals !== undefined && existing?.data !== cond.ifDataEquals) return false;
    this.items.set(this.key(item.PK, item.SK), structuredClone(item));
    return true;
  }

  async get(pk: string, sk: string): Promise<Item | undefined> {
    const it = this.items.get(this.key(pk, sk));
    return it ? structuredClone(it) : undefined;
  }

  async query(q: QuerySpec): Promise<Item[]> {
    const pkName = q.index ? "GSI1PK" : "PK";
    const skName = q.index ? "GSI1SK" : "SK";
    let rows = [...this.items.values()].filter((i) => i[pkName] === q.pk);
    if (q.skPrefix !== undefined) rows = rows.filter((i) => String(i[skName] ?? "").startsWith(q.skPrefix as string));
    // DynamoDB sorts by sort key, ties broken by the table key (stable for our purposes).
    rows.sort((a, b) => {
      const x = String(a[skName] ?? "");
      const y = String(b[skName] ?? "");
      if (x !== y) return x < y ? -1 : 1;
      return a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0;
    });
    if (!(q.forward ?? true)) rows.reverse();
    if (q.startAfterSk !== undefined && !q.index) {
      const after = q.startAfterSk;
      const idx = rows.findIndex((r) => r.SK === after);
      if (idx >= 0) rows = rows.slice(idx + 1);
      else rows = rows.filter((r) => ((q.forward ?? true) ? r.SK > after : r.SK < after));
    }
    if (q.limit) rows = rows.slice(0, q.limit);
    return rows.map((r) => structuredClone(r));
  }

  async delete(pk: string, sk: string): Promise<void> {
    this.items.delete(this.key(pk, sk));
  }
}

export function createMemoryRepo(opts: TableRepoOptions = {}): TableRepo & { table: MemoryTable } {
  const table = new MemoryTable();
  return Object.assign(new TableRepo(table, opts), { table });
}

export type { Repo };

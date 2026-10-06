import type { Conversation } from "./types";

const g = globalThis as unknown as { __addonSimConversations?: Map<string, Conversation> };

function store(): Map<string, Conversation> {
  return (g.__addonSimConversations ??= new Map());
}

export function newConversation(id: string): Conversation {
  return { id, turns: [], messages: [] };
}

/** Conversation memory per session id (process-local; fine for a simulator). */
export function getConversation(id: string): Conversation {
  const s = store();
  let c = s.get(id);
  if (!c) {
    c = newConversation(id);
    s.set(id, c);
  }
  return c;
}

export function resetConversation(id: string): void {
  store().delete(id);
}

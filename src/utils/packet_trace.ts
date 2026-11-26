import fs from 'fs';
import path from 'path';
import type { Bot } from 'mineflayer';

/**
 * Optional low-level trace for debugging: every inventory-related packet in both directions, plus every
 * action start, finish and preemption, written as NDJSON with millisecond timestamps on one timeline.
 *
 * Off unless AICRAFT_PACKET_TRACE is set. When off, traceEvent() is a no-op, so callers can leave their
 * calls in place.
 */

const INBOUND = new Set(['set_slot', 'window_items', 'set_cursor_item', 'set_player_inventory', 'open_window', 'close_window', 'collect']);
const OUTBOUND = new Set(['window_click', 'close_window', 'held_item_slot', 'block_place', 'use_item', 'block_dig', 'craft_recipe_request']);

let stream: fs.WriteStream | null = null;
let currentAction: string | null = null;

function write(entry: Record<string, unknown>): void {
  if (!stream) return;
  stream.write(`${JSON.stringify({ t: new Date().toISOString(), action: currentAction, ...entry })}\n`);
}

function itemBrief(item: any): string | null {
  if (!item || !item.itemCount) return null;
  return `${item.itemId}x${item.itemCount}`;
}

function briefInbound(name: string, data: any): Record<string, unknown> {
  switch (name) {
    case 'set_slot':
      return { windowId: data.windowId, stateId: data.stateId, slot: data.slot, item: itemBrief(data.item) };
    case 'window_items':
      return {
        windowId: data.windowId,
        stateId: data.stateId,
        carried: itemBrief(data.carriedItem),
        slots: (data.items ?? []).map((it: any, i: number) => (it?.itemCount ? `${i}:${itemBrief(it)}` : null)).filter(Boolean),
      };
    case 'set_cursor_item':
      return { item: itemBrief(data.contents ?? data.item ?? data) };
    case 'set_player_inventory':
      return { slot: data.slotId ?? data.slot, item: itemBrief(data.contents ?? data.item) };
    case 'collect':
      return { collected: data.collectedEntityId, collector: data.collectorEntityId, count: data.pickupItemCount };
    default:
      return { data };
  }
}

function briefOutbound(name: string, params: any): Record<string, unknown> {
  if (name === 'window_click') {
    return {
      windowId: params.windowId,
      stateId: params.stateId,
      slot: params.slot,
      button: params.mouseButton,
      mode: params.mode,
      changed: (params.changedSlots ?? []).map((c: any) => `${c.location}:${itemBrief(c.item) ?? '-'}`),
      cursor: itemBrief(params.cursorItem),
    };
  }
  return { params };
}

/** Records an agent-level event (action start/finish/preempt, skill notes) on the packet timeline. */
export function traceEvent(kind: string, data: Record<string, unknown> = {}): void {
  if (!stream) return;
  if (kind === 'action_start' && typeof data.name === 'string') currentAction = data.name;
  write({ dir: 'agent', kind, ...data });
  if (kind === 'action_current') currentAction = (data.name as string | null) ?? null;
}

export function packetTraceEnabled(): boolean {
  return Boolean(process.env.AICRAFT_PACKET_TRACE);
}

/** Starts tracing this bot's packets into filePath. Safe to call again after a reconnect. */
export function installPacketTrace(bot: Bot, filePath: string): void {
  if (!packetTraceEnabled()) return;
  if (!stream) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    stream = fs.createWriteStream(filePath, { flags: 'a' });
  }
  const client: any = (bot as any)._client;
  client.on('packet', (data: any, meta: any) => {
    if (INBOUND.has(meta.name)) write({ dir: 'in', name: meta.name, ...briefInbound(meta.name, data) });
  });
  const originalWrite = client.write.bind(client);
  client.write = (name: string, params: any) => {
    if (OUTBOUND.has(name)) write({ dir: 'out', name, ...briefOutbound(name, params) });
    return originalWrite(name, params);
  };
  write({ dir: 'agent', kind: 'trace_installed' });
}

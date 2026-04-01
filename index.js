import { WebSocketServer } from "ws";
import { loadMap, isBlocked } from "./map.js";
import { findPathAStar } from "./pathfinding.js";

const TICK_HZ = 20;
const TICK_MS = Math.floor(1000 / TICK_HZ);

const TILES_PER_SEC = 5;
const TILES_PER_TICK = TILES_PER_SEC / TICK_HZ;
const NPC_TILES_PER_SEC = 1.5; // Porings are slow and cute
const NPC_TILES_PER_TICK = NPC_TILES_PER_SEC / TICK_HZ;

const AOI_RADIUS = 18;

const map = loadMap();
let tick = 0;

const players = new Map();
const npcs    = new Map(); // id -> npc
let removed = new Set();

function uid() {
  return "p_" + Math.random().toString(36).slice(2, 10);
}
function npcId() {
  return "npc_" + Math.random().toString(36).slice(2, 10);
}
function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function inAOI(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return (dx * dx + dy * dy) <= (AOI_RADIUS * AOI_RADIUS);
}

// Snapshot includes both players and npcs
function snapshotFor(p) {
  const arr = [];
  for (const other of players.values()) {
    if (inAOI(p, other)) arr.push({ id: other.id, x: other.x, y: other.y, name: other.name });
  }
  return arr;
}
function npcSnapshotFor(p) {
  const arr = [];
  for (const npc of npcs.values()) {
    if (inAOI(p, npc)) arr.push({ id: npc.id, x: npc.x, y: npc.y, name: npc.name, kind: npc.kind });
  }
  return arr;
}

// ── Spawn Porings ──
const PORING_SPAWNS = [
  { x: 20, y: 15 },
  { x: 25, y: 18 },
  { x: 18, y: 22 },
  { x: 30, y: 25 },
  { x: 22, y: 12 },
];

for (const spawn of PORING_SPAWNS) {
  if (isBlocked(map, spawn.x, spawn.y)) continue;
  const id = npcId();
  npcs.set(id, {
    id,
    kind: "poring",
    name: "Poring",
    x: spawn.x, y: spawn.y,
    fx: spawn.x, fy: spawn.y,
    path: [],
    dirty: true,
    nextWanderAt: Date.now() + Math.random() * 3000,
  });
}
console.log(`[LERMA] Spawned ${npcs.size} Porings 🛒`);

// ── Poring wander AI ──
function tickNPCs() {
  const now = Date.now();
  for (const npc of npcs.values()) {
    // If path is done, pick a new random destination
    if (npc.path.length === 0 && now >= npc.nextWanderAt) {
      const wanderRange = 5;
      const tx = npc.x + Math.floor((Math.random() - 0.5) * wanderRange * 2);
      const ty = npc.y + Math.floor((Math.random() - 0.5) * wanderRange * 2);

      // Clamp to map bounds
      const cx = Math.max(0, Math.min(map.w - 1, tx));
      const cy = Math.max(0, Math.min(map.h - 1, ty));

      if (!isBlocked(map, cx, cy)) {
        const path = findPathAStar(map, npc.x, npc.y, cx, cy, 200);
        if (path && path.length > 1) {
          npc.path = path.filter(s => !(s.x === npc.x && s.y === npc.y));
        }
      }
      // Wait 3-8 seconds before next wander
      npc.nextWanderAt = now + 3000 + Math.random() * 5000;
    }

    // Move along path
    if (npc.path.length === 0) continue;
    const next = npc.path[0];
    if (npc.x === next.x && npc.y === next.y) { npc.path.shift(); continue; }

    const dx = Math.sign(next.x - npc.x);
    const dy = Math.sign(next.y - npc.y);

    npc.fx += dx * NPC_TILES_PER_TICK;
    npc.fy += dy * NPC_TILES_PER_TICK;

    if (Math.abs(npc.fx - npc.x) >= 1) {
      const nx = npc.x + dx;
      if (!isBlocked(map, nx, npc.y)) { npc.x = nx; npc.dirty = true; }
      else npc.path = [];
      npc.fx = npc.x;
    }
    if (Math.abs(npc.fy - npc.y) >= 1) {
      const ny = npc.y + dy;
      if (!isBlocked(map, npc.x, ny)) { npc.y = ny; npc.dirty = true; }
      else npc.path = [];
      npc.fy = npc.y;
    }
  }
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: 3000 });
console.log("Secrets of Lerma Zone Server listening on ws://127.0.0.1:3000");

wss.on("connection", (ws) => {
  const id = uid();

  let sx = 10, sy = 10;
  while (isBlocked(map, sx, sy)) sx++;

  const p = {
    id, ws,
    name: "Traveler",
    x: sx, y: sy,
    fx: sx, fy: sy,
    path: [],
    dirty: true,
    lastMoveAt: 0,
    welcomed: false
  };

  players.set(id, p);
  send(ws, { t: "WELCOME", id, tick: TICK_HZ, map: { w: map.w, h: map.h } });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.t === "HELLO") {
      p.name = String(msg.name || "Traveler").slice(0, 20);

      const sx = typeof msg.savedX === "number" ? Math.floor(msg.savedX) : null;
      const sy = typeof msg.savedY === "number" ? Math.floor(msg.savedY) : null;

      if (sx !== null && sy !== null &&
          sx >= 0 && sy >= 0 &&
          sx < map.w && sy < map.h &&
          !isBlocked(map, sx, sy)) {
        p.x = sx; p.fx = sx;
        p.y = sy; p.fy = sy;
        console.log(`[LERMA] ${p.name} restored to (${sx}, ${sy})`);
      } else {
        console.log(`[LERMA] ${p.name} spawned at default (${p.x}, ${p.y})`);
      }

      p.dirty = true;

      if (!p.welcomed) {
        p.welcomed = true;
        // Send players + npcs in snapshot
        send(ws, { t: "SNAPSHOT", you: id, players: snapshotFor(p), npcs: npcSnapshotFor(p) });
        for (const other of players.values()) if (inAOI(p, other)) other.dirty = true;
      }
      return;
    }

    if (msg.t === "PING") { send(ws, { t: "PONG", ts: Date.now() }); return; }

    if (msg.t === "MOVE_TO") {
      const now = Date.now();
      if (now - p.lastMoveAt < 60) return;
      p.lastMoveAt = now;

      const tx = Math.floor(msg.x);
      const ty = Math.floor(msg.y);
      if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return;
      if (isBlocked(map, tx, ty)) return;

      const path = findPathAStar(map, p.x, p.y, tx, ty, 700);
      if (!path || path.length < 2) return;
      p.path = path.filter(step => !(step.x === p.x && step.y === p.y));
      return;
    }
  });

  ws.on("close", () => {
    players.delete(id);
    removed.add(id);
    for (const other of players.values()) other.dirty = true;
  });
});

setInterval(() => {
  tick++;

  // Move players
  for (const p of players.values()) {
    if (p.path.length === 0) continue;
    const next = p.path[0];
    if (p.x === next.x && p.y === next.y) { p.path.shift(); continue; }

    const dx = Math.sign(next.x - p.x);
    const dy = Math.sign(next.y - p.y);
    p.fx += dx * TILES_PER_TICK;
    p.fy += dy * TILES_PER_TICK;

    if (Math.abs(p.fx - p.x) >= 1) {
      const nx = p.x + dx;
      if (!isBlocked(map, nx, p.y)) { p.x = nx; p.dirty = true; } else p.path = [];
      p.fx = p.x;
    }
    if (Math.abs(p.fy - p.y) >= 1) {
      const ny = p.y + dy;
      if (!isBlocked(map, p.x, ny)) { p.y = ny; p.dirty = true; } else p.path = [];
      p.fy = p.y;
    }
  }

  // Move NPCs
  tickNPCs();

  // Broadcast to players
  for (const p of players.values()) {
    const up = [];
    for (const other of players.values()) {
      if (!inAOI(p, other)) continue;
      if (other.dirty) up.push({ id: other.id, x: other.x, y: other.y, name: other.name });
    }

    // Include dirty NPCs in delta
    const npcUp = [];
    for (const npc of npcs.values()) {
      if (!inAOI(p, npc)) continue;
      if (npc.dirty) npcUp.push({ id: npc.id, x: npc.x, y: npc.y, name: npc.name, kind: npc.kind });
    }

    const rm = [];
    for (const rid of removed) rm.push(rid);

    if (up.length || rm.length || npcUp.length) {
      send(p.ws, { t: "DELTA", tick, up, rm, npcUp });
    }
  }

  for (const p of players.values()) p.dirty = false;
  for (const npc of npcs.values()) npc.dirty = false;
  removed = new Set();

}, TICK_MS);

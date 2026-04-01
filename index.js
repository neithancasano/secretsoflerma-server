import { WebSocketServer } from "ws";
import { loadMap, isBlocked } from "./map.js";
import { findPathAStar } from "./pathfinding.js";

const TICK_HZ = 20;
const TICK_MS = Math.floor(1000 / TICK_HZ);

const TILES_PER_SEC = 5;
const TILES_PER_TICK = TILES_PER_SEC / TICK_HZ;

const AOI_RADIUS = 18; // tiles

const map = loadMap();
let tick = 0;

const players = new Map(); // id -> player
let removed = new Set();   // ids removed since last tick

function uid() {
  return "p_" + Math.random().toString(36).slice(2, 10);
}
function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function inAOI(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return (dx * dx + dy * dy) <= (AOI_RADIUS * AOI_RADIUS);
}
function snapshotFor(p) {
  const arr = [];
  for (const other of players.values()) {
    if (inAOI(p, other)) arr.push({ id: other.id, x: other.x, y: other.y, name: other.name });
  }
  return arr;
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: 3000 });
console.log("Secrets of Lerma Zone Server listening on ws://127.0.0.1:3000");

wss.on("connection", (ws) => {
  const id = uid();

  let sx = 10, sy = 10;
  while (isBlocked(map, sx, sy)) sx++;

  const p = {
    id,
    ws,
    name: "Traveler",
    x: sx, y: sy,
    fx: sx, fy: sy,
    path: [],
    dirty: true,
    lastMoveAt: 0,
    welcomed: false  // wait for HELLO before sending SNAPSHOT
  };

  players.set(id, p);

  // Send WELCOME immediately so client knows its id and map size
  send(ws, { t: "WELCOME", id, tick: TICK_HZ, map: { w: map.w, h: map.h } });
  // SNAPSHOT is sent after HELLO arrives with the real name

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.t === "HELLO") {
      p.name = String(msg.name || "Traveler").slice(0, 20);
      p.dirty = true;

      // Now send the SNAPSHOT with the real name already set
      if (!p.welcomed) {
        p.welcomed = true;
        send(ws, { t: "SNAPSHOT", you: id, players: snapshotFor(p) });
        // Mark everyone near as dirty so newcomers appear quickly
        for (const other of players.values()) if (inAOI(p, other)) other.dirty = true;
      }
      return;
    }

    if (msg.t === "PING") {
      send(ws, { t: "PONG", ts: Date.now() });
      return;
    }

    if (msg.t === "MOVE_TO") {
      const now = Date.now();
      if (now - p.lastMoveAt < 60) return; // light spam guard
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

  // simulate movement
  for (const p of players.values()) {
    if (p.path.length === 0) continue;

    const next = p.path[0];
    if (p.x === next.x && p.y === next.y) {
      p.path.shift();
      continue;
    }

    const dx = Math.sign(next.x - p.x);
    const dy = Math.sign(next.y - p.y);

    p.fx += dx * TILES_PER_TICK;
    p.fy += dy * TILES_PER_TICK;

    if (Math.abs(p.fx - p.x) >= 1) {
      const nx = p.x + dx;
      if (!isBlocked(map, nx, p.y)) {
        p.x = nx;
        p.dirty = true;
      } else {
        p.path = [];
      }
      p.fx = p.x;
    }

    if (Math.abs(p.fy - p.y) >= 1) {
      const ny = p.y + dy;
      if (!isBlocked(map, p.x, ny)) {
        p.y = ny;
        p.dirty = true;
      } else {
        p.path = [];
      }
      p.fy = p.y;
    }
  }

  // broadcast deltas per player AOI
  for (const p of players.values()) {
    const up = [];
    for (const other of players.values()) {
      if (!inAOI(p, other)) continue;
      if (other.dirty) up.push({ id: other.id, x: other.x, y: other.y, name: other.name });
    }

    const rm = [];
    for (const rid of removed) rm.push(rid);

    if (up.length || rm.length) {
      send(p.ws, { t: "DELTA", tick, up, rm });
    }
  }

  // clear dirty + removals
  for (const p of players.values()) p.dirty = false;
  removed = new Set();

}, TICK_MS);

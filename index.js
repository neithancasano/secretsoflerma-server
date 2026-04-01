import { WebSocketServer } from "ws";
import { loadMap, isBlocked } from "./map.js";
import { findPathAStar } from "./pathfinding.js";

const TICK_HZ = 20;
const TICK_MS = Math.floor(1000 / TICK_HZ);

const TILES_PER_SEC      = 5;
const TILES_PER_TICK     = TILES_PER_SEC / TICK_HZ;
const NPC_TILES_PER_SEC  = 2.5;
const NPC_TILES_PER_TICK = NPC_TILES_PER_SEC / TICK_HZ;

const AOI_RADIUS          = 18;
const ATTACK_RANGE        = 1.5; // strict melee — ranged is a future class privilege
const ATTACK_COOLDOWN     = 1000;
const PORING_ATK_COOLDOWN = 2000;
const PORING_ATK_DMG      = 5;
const PORING_MAX_HP       = 50;
const PORING_BASE_DMG     = 8;
const PORING_RESPAWN_MS   = 10000;
const LEASH_RANGE         = 12;

const map = loadMap();
let tick = 0;

const players = new Map();
const npcs    = new Map();
let removed   = new Set();

function uid()   { return "p_"   + Math.random().toString(36).slice(2, 10); }
function npcId() { return "npc_" + Math.random().toString(36).slice(2, 10); }
function send(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function inAOI(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return (dx*dx + dy*dy) <= AOI_RADIUS * AOI_RADIUS;
}
function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx*dx + dy*dy);
}

function snapshotFor(p) {
  const arr = [];
  for (const other of players.values())
    if (inAOI(p, other)) arr.push({ id: other.id, x: other.x, y: other.y, name: other.name });
  return arr;
}
function npcSnapshotFor(p) {
  const arr = [];
  for (const npc of npcs.values())
    if (!npc.isDead && inAOI(p, npc))
      arr.push({ id: npc.id, x: npc.x, y: npc.y, name: npc.name, kind: npc.kind, hp: npc.hp, maxHp: npc.maxHp });
  return arr;
}
function broadcastNear(pos, obj) {
  for (const p of players.values())
    if (inAOI(p, pos)) send(p.ws, obj);
}

// ── Spawn Porings ──
const PORING_SPAWNS = [
  { x: 20, y: 15 }, { x: 25, y: 18 },
  { x: 18, y: 22 }, { x: 30, y: 25 }, { x: 22, y: 12 },
];

function spawnPoring(spawnPos) {
  const id = npcId();
  npcs.set(id, {
    id, kind: "poring", name: "Poring",
    x: spawnPos.x, y: spawnPos.y,
    fx: spawnPos.x, fy: spawnPos.y,
    spawnX: spawnPos.x, spawnY: spawnPos.y,
    hp: PORING_MAX_HP, maxHp: PORING_MAX_HP,
    isDead: false, respawnAt: null,
    aggroTarget: null,
    lastNpcAtkAt: 0, lastChaseAt: 0,
    path: [], dirty: true,
    nextWanderAt: Date.now() + Math.random() * 3000,
  });
  return id;
}

for (const spawn of PORING_SPAWNS) {
  if (!isBlocked(map, spawn.x, spawn.y)) spawnPoring(spawn);
}
console.log(`[LERMA] Spawned ${npcs.size} Porings`);

// ── Respawn check ──
setInterval(() => {
  const now = Date.now();
  for (const npc of npcs.values()) {
    if (npc.isDead && npc.respawnAt && now >= npc.respawnAt) {
      npc.x = npc.spawnX; npc.y = npc.spawnY;
      npc.fx = npc.spawnX; npc.fy = npc.spawnY;
      npc.hp = npc.maxHp;
      npc.isDead = false; npc.respawnAt = null;
      npc.aggroTarget = null;
      npc.path = []; npc.dirty = true;
      npc.nextWanderAt = Date.now() + 1000;
      broadcastNear(npc, { t: "NPC_SPAWN", id: npc.id, x: npc.x, y: npc.y, name: npc.name, kind: npc.kind, hp: npc.hp, maxHp: npc.maxHp });
      console.log(`[LERMA] Poring ${npc.id} respawned`);
    }
  }
}, 1000);

// ── NPC AI tick ──
function tickNPCs() {
  const now = Date.now();
  for (const npc of npcs.values()) {
    if (npc.isDead) continue;

    if (npc.aggroTarget) {
      const target = players.get(npc.aggroTarget);

      if (!target || dist(npc, { x: npc.spawnX, y: npc.spawnY }) > LEASH_RANGE) {
        npc.aggroTarget = null;
        npc.path = [];
        npc.nextWanderAt = now + 1000;
        const back = findPathAStar(map, npc.x, npc.y, npc.spawnX, npc.spawnY, 300);
        if (back && back.length > 1) npc.path = back.filter(s => !(s.x===npc.x && s.y===npc.y));
        broadcastNear(npc, { t: "NPC_LEASH", npcId: npc.id });
        continue;
      }

      const d = dist(npc, target);
      if (d <= ATTACK_RANGE) {
        npc.path = [];
        if (now - npc.lastNpcAtkAt >= PORING_ATK_COOLDOWN) {
          npc.lastNpcAtkAt = now;
          const dmg = PORING_ATK_DMG + Math.floor(Math.random() * 3);
          send(target.ws, { t: "PLAYER_HIT", dmg, attackerId: npc.id });
          console.log(`[LERMA] Poring hit ${target.name} for ${dmg}!`);
        }
      } else {
        if (now - npc.lastChaseAt > 500 || npc.path.length === 0) {
          npc.lastChaseAt = now;
          const path = findPathAStar(map, npc.x, npc.y, target.x, target.y, 300);
          if (path && path.length > 1) npc.path = path.filter(s => !(s.x===npc.x && s.y===npc.y));
        }
      }
    } else {
      if (npc.path.length === 0 && now >= npc.nextWanderAt) {
        const wanderRange = 5;
        const tx = Math.max(0, Math.min(map.w-1, npc.x + Math.floor((Math.random()-0.5)*wanderRange*2)));
        const ty = Math.max(0, Math.min(map.h-1, npc.y + Math.floor((Math.random()-0.5)*wanderRange*2)));
        if (!isBlocked(map, tx, ty)) {
          const path = findPathAStar(map, npc.x, npc.y, tx, ty, 200);
          if (path && path.length > 1) npc.path = path.filter(s => !(s.x===npc.x && s.y===npc.y));
        }
        npc.nextWanderAt = now + 3000 + Math.random() * 5000;
      }
    }

    if (npc.path.length === 0) continue;
    const next = npc.path[0];
    if (npc.x === next.x && npc.y === next.y) { npc.path.shift(); continue; }
    const dx = Math.sign(next.x - npc.x);
    const dy = Math.sign(next.y - npc.y);
    npc.fx += dx * NPC_TILES_PER_TICK;
    npc.fy += dy * NPC_TILES_PER_TICK;
    if (Math.abs(npc.fx - npc.x) >= 1) {
      const nx = npc.x + dx;
      if (!isBlocked(map, nx, npc.y)) { npc.x = nx; npc.dirty = true; } else npc.path = [];
      npc.fx = npc.x;
    }
    if (Math.abs(npc.fy - npc.y) >= 1) {
      const ny = npc.y + dy;
      if (!isBlocked(map, npc.x, ny)) { npc.y = ny; npc.dirty = true; } else npc.path = [];
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
    id, ws, name: "Traveler",
    x: sx, y: sy, fx: sx, fy: sy,
    path: [], dirty: true,
    lastMoveAt: 0, lastAttackAt: 0,
    lastChaseNpcAt: 0,
    attackTarget: null,
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
      if (sx !== null && sy !== null && sx >= 0 && sy >= 0 && sx < map.w && sy < map.h && !isBlocked(map, sx, sy)) {
        p.x = sx; p.fx = sx; p.y = sy; p.fy = sy;
      }
      p.dirty = true;
      if (!p.welcomed) {
        p.welcomed = true;
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
      p.attackTarget = null;
      const tx = Math.floor(msg.x), ty = Math.floor(msg.y);
      if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return;
      if (isBlocked(map, tx, ty)) return;
      const path = findPathAStar(map, p.x, p.y, tx, ty, 700);
      if (!path || path.length < 2) return;
      p.path = path.filter(step => !(step.x === p.x && step.y === p.y));
      return;
    }

    if (msg.t === "ATTACK_NPC") {
      const npc = npcs.get(msg.npcId);
      if (!npc || npc.isDead) return;
      p.attackTarget = msg.npcId;
      p.path = [];
      p.lastChaseNpcAt = 0;
      if (!npc.aggroTarget) {
        npc.aggroTarget = p.id;
        npc.path = [];
        broadcastNear(npc, { t: "NPC_AGGRO", npcId: npc.id });
        console.log(`[LERMA] Poring ${npc.id} aggroed by ${p.name}`);
      }
      return;
    }

    if (msg.t === "CANCEL_ATTACK") {
      p.attackTarget = null;
      return;
    }
  });

  ws.on("close", () => {
    for (const npc of npcs.values()) {
      if (npc.aggroTarget === id) { npc.aggroTarget = null; npc.path = []; }
    }
    players.delete(id);
    removed.add(id);
    for (const other of players.values()) other.dirty = true;
  });
});

// ── Auto attack tick ──
setInterval(() => {
  const now = Date.now();
  for (const p of players.values()) {
    if (!p.attackTarget) continue;
    const npc = npcs.get(p.attackTarget);
    if (!npc || npc.isDead) { p.attackTarget = null; continue; }

    const d = dist(p, npc);

    if (d > ATTACK_RANGE) {
      if (now - p.lastChaseNpcAt > 400) {
        p.lastChaseNpcAt = now;
        const path = findPathAStar(map, p.x, p.y, npc.x, npc.y, 300);
        if (path && path.length > 1) {
          p.path = path.filter(s => !(s.x === p.x && s.y === p.y));
          console.log(`[LERMA] ${p.name} chasing Poring, dist=${d.toFixed(1)}`);
        }
      }
      continue;
    }

    p.path = [];
    if (now - p.lastAttackAt < ATTACK_COOLDOWN) continue;
    p.lastAttackAt = now;

    const dmg = PORING_BASE_DMG + Math.floor(Math.random() * 5);
    npc.hp = Math.max(0, npc.hp - dmg);
    npc.dirty = true;

    console.log(`[LERMA] ${p.name} hit Poring for ${dmg}! HP: ${npc.hp}/${npc.maxHp}`);
    broadcastNear(npc, { t: "NPC_HIT", npcId: npc.id, dmg, hp: npc.hp, maxHp: npc.maxHp, attackerId: p.id });

    if (npc.hp <= 0) {
      npc.isDead = true;
      npc.aggroTarget = null;
      npc.path = [];
      npc.respawnAt = now + PORING_RESPAWN_MS;
      p.attackTarget = null;
      broadcastNear(npc, { t: "NPC_DIED", npcId: npc.id, killerId: p.id });
      console.log(`[LERMA] Poring ${npc.id} slain by ${p.name}!`);
    }
  }
}, 100);

setInterval(() => {
  tick++;

  for (const p of players.values()) {
    if (p.path.length === 0) continue;
    const next = p.path[0];
    if (p.x === next.x && p.y === next.y) { p.path.shift(); continue; }
    const dx = Math.sign(next.x - p.x), dy = Math.sign(next.y - p.y);
    p.fx += dx * TILES_PER_TICK; p.fy += dy * TILES_PER_TICK;
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

  tickNPCs();

  for (const p of players.values()) {
    const up = [];
    for (const other of players.values())
      if (inAOI(p, other) && other.dirty) up.push({ id: other.id, x: other.x, y: other.y, name: other.name });
    const npcUp = [];
    for (const npc of npcs.values())
      if (!npc.isDead && inAOI(p, npc) && npc.dirty) npcUp.push({ id: npc.id, x: npc.x, y: npc.y, name: npc.name, kind: npc.kind, hp: npc.hp, maxHp: npc.maxHp });
    const rm = [...removed];
    if (up.length || rm.length || npcUp.length) send(p.ws, { t: "DELTA", tick, up, rm, npcUp });
  }

  for (const p of players.values()) p.dirty = false;
  for (const npc of npcs.values()) npc.dirty = false;
  removed = new Set();
}, TICK_MS);

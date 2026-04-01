import { WebSocketServer } from "ws";
import { loadMap, isBlocked } from "./map.js";
import { findPathAStar } from "./pathfinding.js";
import { readFileSync } from "fs";
import {
  defaultStats, deriveStats, statCost,
  expToNextLevel, STAT_POINTS_PER_LEVEL, EXP_TABLE,
  calcAtk, calcAspd, calcMaxHp, calcDef, calcCritRate
} from "./stats.js";

const TICK_HZ = 20;
const TICK_MS = Math.floor(1000 / TICK_HZ);
const TILES_PER_SEC      = 5;
const TILES_PER_TICK     = TILES_PER_SEC / TICK_HZ;
const NPC_TILES_PER_SEC  = 2.5;
const NPC_TILES_PER_TICK = NPC_TILES_PER_SEC / TICK_HZ;
const AOI_RADIUS          = 18;
const ATTACK_RANGE        = 1.5;
const ATTACK_COOLDOWN     = 1000;
const PORING_ATK_COOLDOWN = 2000;
const PORING_ATK_DMG      = 5;
const PORING_MAX_HP       = 50;
const PORING_RESPAWN_MS   = 10000;
const LEASH_RANGE         = 12;
const CRIT_MULTIPLIER     = 1.5;
const PORTAL_COOLDOWN_MS  = 2000; // prevent portal spam

// ── Load all zones ──
function loadZone(id) {
  try {
    const data = JSON.parse(readFileSync(`./zones/${id}.json`, 'utf8'));
    // Build blocked set for fast lookup
    data.blockedSet = new Set(data.blocked || []);
    console.log(`[LERMA] Loaded zone: ${data.name} (${data.w}x${data.h})`);
    return data;
  } catch(e) {
    console.error(`[LERMA] Failed to load zone ${id}:`, e.message);
    return null;
  }
}

const ZONES = {};
for (const id of ['lerma','lerma-norte','lerma-sur','punta-banka','bagumbayan']) {
  const z = loadZone(id);
  if (z) ZONES[id] = z;
}

function isBlockedInZone(zone, x, y) {
  return zone.blockedSet.has(`${x},${y}`);
}

// Keep the old map.js for pathfinding compatibility
const map = loadMap();
let tick = 0;

const players = new Map(); // playerId -> player
const npcs    = new Map();
let removed   = new Set();

// Zone -> Set of player IDs in that zone
const zoneOccupants = {};
for (const id of Object.keys(ZONES)) zoneOccupants[id] = new Set();

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

// Only players in the same zone
function snapshotFor(p) {
  const arr = [];
  for (const id of zoneOccupants[p.zone] || []) {
    const other = players.get(id);
    if (other && other !== p && inAOI(p, other))
      arr.push({ id: other.id, x: other.x, y: other.y, name: other.name, level: other.stats.level });
  }
  return arr;
}
function npcSnapshotFor(p) {
  const arr = [];
  for (const npc of npcs.values())
    if (npc.zone === p.zone && !npc.isDead && inAOI(p, npc))
      arr.push({ id: npc.id, x: npc.x, y: npc.y, name: npc.name, kind: npc.kind, hp: npc.hp, maxHp: npc.maxHp });
  return arr;
}
function broadcastNear(p, obj) {
  for (const id of zoneOccupants[p.zone] || []) {
    const other = players.get(id);
    if (other && inAOI(p, other)) send(other.ws, obj);
  }
}
function broadcastNearNpc(npc, obj) {
  for (const id of zoneOccupants[npc.zone] || []) {
    const p = players.get(id);
    if (p && inAOI(p, npc)) send(p.ws, obj);
  }
}

// ── Spawn Porings in lerma zone only for now ──
const PORING_SPAWNS = [
  { x: 20, y: 15, zone: 'lerma' }, { x: 25, y: 18, zone: 'lerma' },
  { x: 18, y: 22, zone: 'lerma' }, { x: 30, y: 25, zone: 'lerma' }, { x: 22, y: 12, zone: 'lerma' },
  { x: 20, y: 15, zone: 'lerma-norte' }, { x: 30, y: 10, zone: 'lerma-norte' },
  { x: 20, y: 25, zone: 'lerma-sur'  }, { x: 35, y: 30, zone: 'lerma-sur'  },
  { x: 30, y: 20, zone: 'punta-banka'}, { x: 40, y: 30, zone: 'punta-banka'},
  { x: 30, y: 15, zone: 'bagumbayan' }, { x: 45, y: 32, zone: 'bagumbayan' },
];

function spawnPoring(spawnPos) {
  const id = npcId();
  npcs.set(id, {
    id, kind: "poring", name: "Poring", zone: spawnPos.zone,
    x: spawnPos.x, y: spawnPos.y,
    fx: spawnPos.x, fy: spawnPos.y,
    spawnX: spawnPos.x, spawnY: spawnPos.y,
    hp: PORING_MAX_HP, maxHp: PORING_MAX_HP,
    isDead: false, respawnAt: null,
    aggroTarget: null, lastNpcAtkAt: 0, lastChaseAt: 0,
    path: [], dirty: true,
    nextWanderAt: Date.now() + Math.random() * 3000,
  });
}

for (const spawn of PORING_SPAWNS) spawnPoring(spawn);
console.log(`[LERMA] Spawned ${npcs.size} Porings across all zones`);

// ── Spawn Migs NPCs in each zone ──
const MIGS_GREETINGS = [
  "Hoy! Kumusta ka? Ako si Migs, halikayo!",
  "Oy pare, maingat ka diyan ha!",
  "Migs here! Ano kailangan mo?",
  "Tara, tulungan kita!",
];

for (const [zoneId, zone] of Object.entries(ZONES)) {
  if (!zone.migs) continue;
  const id = `migs_${zoneId}`;
  npcs.set(id, {
    id, kind: "migs", name: "Migs", zone: zoneId,
    x: zone.migs.x, y: zone.migs.y,
    fx: zone.migs.x, fy: zone.migs.y,
    spawnX: zone.migs.x, spawnY: zone.migs.y,
    hp: 9999, maxHp: 9999,
    isDead: false, respawnAt: null,
    aggroTarget: null, path: [], dirty: true,
    nextWanderAt: Infinity, // Migs doesn't wander
    isMigs: true,
    greeting: MIGS_GREETINGS[Math.floor(Math.random() * MIGS_GREETINGS.length)],
  });
  console.log(`[LERMA] Migs spawned in ${zoneId} at (${zone.migs.x}, ${zone.migs.y})`);
}

// ── Respawn check ──
setInterval(() => {
  const now = Date.now();
  for (const npc of npcs.values()) {
    if (!npc.isDead || !npc.respawnAt || now < npc.respawnAt) continue;
    npc.x = npc.spawnX; npc.y = npc.spawnY;
    npc.fx = npc.spawnX; npc.fy = npc.spawnY;
    npc.hp = npc.maxHp;
    npc.isDead = false; npc.respawnAt = null;
    npc.aggroTarget = null;
    npc.path = []; npc.dirty = true;
    npc.nextWanderAt = Date.now() + 1000;
    broadcastNearNpc(npc, { t: "NPC_SPAWN", id: npc.id, x: npc.x, y: npc.y, name: npc.name, kind: npc.kind, hp: npc.hp, maxHp: npc.maxHp });
  }
}, 1000);

// ── EXP ──
function grantExp(p, amount) {
  p.stats.exp += amount;
  while (p.stats.exp >= expToNextLevel(p.stats.level)) {
    p.stats.exp -= expToNextLevel(p.stats.level);
    p.stats.level++;
    p.stats.statPoints += STAT_POINTS_PER_LEVEL;
    const newMaxHp = calcMaxHp(p.stats.level, p.stats.vit);
    p.hp = newMaxHp; p.maxHp = newMaxHp;
    console.log(`[LERMA] ${p.name} reached level ${p.stats.level}!`);
    broadcastNear(p, { t: "PLAYER_LEVEL_UP", playerId: p.id, name: p.name, level: p.stats.level });
  }
  send(p.ws, { t: "STATS_UPDATE", stats: deriveStats(p.stats), hp: p.hp, maxHp: p.maxHp });
}

// ── Portal check ──
function checkPortal(p) {
  const zone = ZONES[p.zone];
  if (!zone) return;
  const now = Date.now();
  if (now - (p.lastPortalAt || 0) < PORTAL_COOLDOWN_MS) return;

  const portals = [
    zone.portalNorth, zone.portalSouth, zone.portalWest, zone.portalEast
  ].filter(Boolean);

  for (const portal of portals) {
    if (p.x === portal.x && p.y === portal.y) {
      const toZone = ZONES[portal.toZone];
      if (!toZone) continue;
      p.lastPortalAt = now;
      teleportPlayer(p, portal.toZone, portal.toX, portal.toY);
      return;
    }
  }
}

function teleportPlayer(p, toZoneId, toX, toY) {
  const fromZone = p.zone;

  // Remove from old zone
  if (zoneOccupants[fromZone]) zoneOccupants[fromZone].delete(p.id);
  // Notify old zone players this player left
  removed.add(p.id);

  // Update player
  p.zone = toZoneId;
  p.x = toX; p.fx = toX;
  p.y = toY; p.fy = toY;
  p.path = [];
  p.attackTarget = null;

  // Add to new zone
  if (!zoneOccupants[toZoneId]) zoneOccupants[toZoneId] = new Set();
  zoneOccupants[toZoneId].add(p.id);

  const toZone = ZONES[toZoneId];
  // Send zone change to player
  send(p.ws, {
    t: "ZONE_CHANGE",
    zone: toZoneId,
    zoneName: toZone?.name || toZoneId,
    x: toX, y: toY,
    map: { w: toZone?.w || 60, h: toZone?.h || 40 },
    players: snapshotFor(p),
    npcs: npcSnapshotFor(p),
  });

  p.dirty = true;
  // Notify new zone players
  for (const id of zoneOccupants[toZoneId]) {
    const other = players.get(id);
    if (other && other !== p) other.dirty = true;
  }

  console.log(`[LERMA] ${p.name} teleported from ${fromZone} to ${toZoneId} (${toX},${toY})`);
}

// ── NPC AI ──
function tickNPCs() {
  const now = Date.now();
  for (const npc of npcs.values()) {
    if (npc.isDead || npc.isMigs) continue;

    if (npc.aggroTarget) {
      const target = players.get(npc.aggroTarget);
      if (!target || target.zone !== npc.zone || dist(npc, { x: npc.spawnX, y: npc.spawnY }) > LEASH_RANGE) {
        npc.aggroTarget = null; npc.path = []; npc.nextWanderAt = now + 1000;
        const back = findPathAStar(map, npc.x, npc.y, npc.spawnX, npc.spawnY, 300);
        if (back && back.length > 1) npc.path = back.filter(s => !(s.x===npc.x && s.y===npc.y));
        continue;
      }
      const d = dist(npc, target);
      if (d <= ATTACK_RANGE) {
        npc.path = [];
        if (now - npc.lastNpcAtkAt >= PORING_ATK_COOLDOWN) {
          npc.lastNpcAtkAt = now;
          const def = calcDef(target.stats.vit);
          const dmg = Math.max(1, PORING_ATK_DMG + Math.floor(Math.random()*3) - def);
          target.hp = Math.max(0, target.hp - dmg);
          send(target.ws, { t: "PLAYER_HIT", dmg, hp: target.hp, maxHp: target.maxHp, attackerId: npc.id });
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
        const tx = Math.max(0, Math.min(59, npc.x + Math.floor((Math.random()-0.5)*wanderRange*2)));
        const ty = Math.max(0, Math.min(39, npc.y + Math.floor((Math.random()-0.5)*wanderRange*2)));
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
    const dx = Math.sign(next.x - npc.x), dy = Math.sign(next.y - npc.y);
    npc.fx += dx * NPC_TILES_PER_TICK; npc.fy += dy * NPC_TILES_PER_TICK;
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

  const baseStats = defaultStats();
  const startMaxHp = calcMaxHp(baseStats.level, baseStats.vit);

  const p = {
    id, ws, name: "Traveler",
    zone: 'lerma', // default zone
    x: sx, y: sy, fx: sx, fy: sy,
    path: [], dirty: true,
    lastMoveAt: 0, lastAttackAt: 0, lastChaseNpcAt: 0,
    lastPortalAt: 0,
    attackTarget: null, welcomed: false,
    stats: { ...baseStats },
    hp: startMaxHp, maxHp: startMaxHp,
    respawnZone: 'lerma', respawnX: sx, respawnY: sy,
  };

  players.set(id, p);
  send(ws, { t: "WELCOME", id, tick: TICK_HZ, map: { w: 60, h: 40 } });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.t === "HELLO") {
      p.name = String(msg.name || "Traveler").slice(0, 20);
      const sx = typeof msg.savedX === "number" ? Math.floor(msg.savedX) : null;
      const sy = typeof msg.savedY === "number" ? Math.floor(msg.savedY) : null;
      if (sx !== null && sy !== null && sx >= 0 && sy >= 0 && sx < 60 && sy < 40 && !isBlocked(map, sx, sy)) {
        p.x = sx; p.fx = sx; p.y = sy; p.fy = sy;
      }
      // Restore zone
      if (msg.savedZone && ZONES[msg.savedZone]) {
        p.zone = msg.savedZone;
      }
      // Restore respawn point
      if (msg.respawnZone && ZONES[msg.respawnZone]) {
        p.respawnZone = msg.respawnZone;
        p.respawnX = msg.respawnX || sx || 10;
        p.respawnY = msg.respawnY || sy || 10;
      }
      if (msg.stats && typeof msg.stats === "object") {
        const s = msg.stats;
        p.stats.level      = Math.max(1, Math.min(99, s.level || 1));
        p.stats.exp        = Math.max(0, s.exp || 0);
        p.stats.statPoints = Math.max(0, s.statPoints || 0);
        ['str','agi','vit','int','dex','luk'].forEach(k => {
          p.stats[k] = Math.max(1, Math.min(99, s[k] || 1));
        });
      }
      p.maxHp = calcMaxHp(p.stats.level, p.stats.vit);
      p.hp    = p.maxHp;
      p.dirty = true;

      if (!zoneOccupants[p.zone]) zoneOccupants[p.zone] = new Set();
      zoneOccupants[p.zone].add(p.id);

      if (!p.welcomed) {
        p.welcomed = true;
        const zone = ZONES[p.zone];
        send(ws, { t: "SNAPSHOT", you: id, zone: p.zone, zoneName: zone?.name, players: snapshotFor(p), npcs: npcSnapshotFor(p) });
        send(ws, { t: "STATS_UPDATE", stats: deriveStats(p.stats), hp: p.hp, maxHp: p.maxHp });
        for (const oid of zoneOccupants[p.zone]) {
          const other = players.get(oid);
          if (other && other !== p && inAOI(p, other)) other.dirty = true;
        }
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
      if (tx < 0 || ty < 0 || tx >= 60 || ty >= 40) return;
      if (isBlocked(map, tx, ty)) return;
      const path = findPathAStar(map, p.x, p.y, tx, ty, 700);
      if (!path || path.length < 2) return;
      p.path = path.filter(step => !(step.x === p.x && step.y === p.y));
      return;
    }

    if (msg.t === "ATTACK_NPC") {
      const npc = npcs.get(msg.npcId);
      if (!npc || npc.isDead || npc.isMigs || npc.zone !== p.zone) return;
      p.attackTarget = msg.npcId;
      p.path = []; p.lastChaseNpcAt = 0;
      if (!npc.aggroTarget) {
        npc.aggroTarget = p.id; npc.path = [];
        broadcastNearNpc(npc, { t: "NPC_AGGRO", npcId: npc.id });
      }
      return;
    }

    if (msg.t === "CANCEL_ATTACK") { p.attackTarget = null; return; }

    if (msg.t === "ADD_STAT") {
      const stat = msg.stat;
      if (!["str","agi","vit","int","dex","luk"].includes(stat)) return;
      const cost = statCost(p.stats[stat]);
      if (p.stats.statPoints < cost) { send(p.ws, { t: "STAT_ERROR", msg: `Need ${cost} pts` }); return; }
      p.stats.statPoints -= cost;
      p.stats[stat]++;
      if (stat === "vit") { const newMax = calcMaxHp(p.stats.level, p.stats.vit); p.hp = Math.min(p.hp+(newMax-p.maxHp),newMax); p.maxHp = newMax; }
      if (stat === "agi") p.attackCooldown = calcAspd(p.stats.agi);
      send(p.ws, { t: "STATS_UPDATE", stats: deriveStats(p.stats), hp: p.hp, maxHp: p.maxHp });
      return;
    }

    // ── Talk to Migs ──
    if (msg.t === "TALK_MIGS") {
      const npc = npcs.get(msg.npcId);
      if (!npc || !npc.isMigs || npc.zone !== p.zone) return;
      if (dist(p, npc) > 2.5) { send(p.ws, { t: "MIGS_TOO_FAR" }); return; }
      send(p.ws, {
        t: "MIGS_OPEN",
        npcId: npc.id,
        greeting: npc.greeting,
        zone: p.zone,
        zoneName: ZONES[p.zone]?.name,
        // List of zones with Migs for teleport menu
        migsZones: Object.keys(ZONES)
          .filter(z => ZONES[z].migs && z !== p.zone)
          .map(z => ({ id: z, name: ZONES[z].name }))
      });
      return;
    }

    // ── Migs: Save respawn point ──
    if (msg.t === "MIGS_SAVE") {
      const npc = npcs.get(msg.npcId);
      if (!npc || !npc.isMigs || npc.zone !== p.zone) return;
      p.respawnZone = p.zone;
      p.respawnX    = p.x;
      p.respawnY    = p.y;
      send(p.ws, { t: "MIGS_SAVED", zone: p.zone, zoneName: ZONES[p.zone]?.name });
      console.log(`[LERMA] ${p.name} saved respawn at ${p.zone} (${p.x},${p.y})`);
      return;
    }

    // ── Migs: Teleport to another Migs ──
    if (msg.t === "MIGS_TELEPORT") {
      const toZoneId = msg.toZone;
      if (!ZONES[toZoneId] || !ZONES[toZoneId].migs) return;
      const toZone = ZONES[toZoneId];
      teleportPlayer(p, toZoneId, toZone.migs.x + 1, toZone.migs.y);
      send(p.ws, { t: "MIGS_BYE", msg: `Sige! Padad ka na sa ${toZone.name}. Ingat!` });
      return;
    }
  });

  ws.on("close", () => {
    for (const npc of npcs.values())
      if (npc.aggroTarget === id) { npc.aggroTarget = null; npc.path = []; }
    if (p.zone && zoneOccupants[p.zone]) zoneOccupants[p.zone].delete(p.id);
    players.delete(id);
    removed.add(id);
    for (const oid of zoneOccupants[p.zone] || []) {
      const other = players.get(oid);
      if (other) other.dirty = true;
    }
  });
});

// ── Auto attack ──
setInterval(() => {
  const now = Date.now();
  for (const p of players.values()) {
    if (!p.attackTarget) continue;
    const npc = npcs.get(p.attackTarget);
    if (!npc || npc.isDead || npc.zone !== p.zone) { p.attackTarget = null; continue; }
    const d = dist(p, npc);
    if (d > ATTACK_RANGE) {
      if (now - p.lastChaseNpcAt > 400) {
        p.lastChaseNpcAt = now;
        const path = findPathAStar(map, p.x, p.y, npc.x, npc.y, 300);
        if (path && path.length > 1) p.path = path.filter(s => !(s.x===p.x && s.y===p.y));
      }
      continue;
    }
    p.path = [];
    const attackCooldown = p.attackCooldown || calcAspd(p.stats.agi);
    if (now - p.lastAttackAt < attackCooldown) continue;
    p.lastAttackAt = now;
    const baseAtk = calcAtk(p.stats.level, p.stats.str);
    let dmg = baseAtk + Math.floor(Math.random()*5);
    let isCrit = false;
    if (Math.random()*100 < calcCritRate(p.stats.luk)) { dmg = Math.floor(dmg*CRIT_MULTIPLIER); isCrit = true; }
    npc.hp = Math.max(0, npc.hp - dmg);
    npc.dirty = true;
    broadcastNearNpc(npc, { t: "NPC_HIT", npcId: npc.id, dmg, hp: npc.hp, maxHp: npc.maxHp, attackerId: p.id, isCrit });
    if (npc.hp <= 0) {
      npc.isDead = true; npc.aggroTarget = null; npc.path = [];
      npc.respawnAt = now + PORING_RESPAWN_MS;
      p.attackTarget = null;
      broadcastNearNpc(npc, { t: "NPC_DIED", npcId: npc.id, killerId: p.id });
      const expGain = EXP_TABLE[npc.kind] || 15;
      grantExp(p, expGain);
      send(p.ws, { t: "EXP_GAIN", amount: expGain, total: p.stats.exp, next: expToNextLevel(p.stats.level) });
    }
  }
}, 100);

setInterval(() => {
  tick++;
  for (const p of players.values()) {
    if (p.path.length === 0) { checkPortal(p); continue; }
    const next = p.path[0];
    if (p.x === next.x && p.y === next.y) { p.path.shift(); continue; }
    const dx = Math.sign(next.x-p.x), dy = Math.sign(next.y-p.y);
    p.fx += dx*TILES_PER_TICK; p.fy += dy*TILES_PER_TICK;
    if (Math.abs(p.fx-p.x) >= 1) {
      const nx = p.x+dx;
      if (!isBlocked(map,nx,p.y)) { p.x=nx; p.dirty=true; } else p.path=[];
      p.fx=p.x;
    }
    if (Math.abs(p.fy-p.y) >= 1) {
      const ny = p.y+dy;
      if (!isBlocked(map,p.x,ny)) { p.y=ny; p.dirty=true; } else p.path=[];
      p.fy=p.y;
    }
    // Check portal after each move step
    checkPortal(p);
  }
  tickNPCs();
  for (const p of players.values()) {
    const up = [];
    for (const oid of zoneOccupants[p.zone]||[]) {
      const other = players.get(oid);
      if (other && other !== p && inAOI(p,other) && other.dirty)
        up.push({ id:other.id, x:other.x, y:other.y, name:other.name, level:other.stats.level });
    }
    const npcUp = [];
    for (const npc of npcs.values())
      if (npc.zone===p.zone && !npc.isDead && inAOI(p,npc) && npc.dirty)
        npcUp.push({ id:npc.id, x:npc.x, y:npc.y, name:npc.name, kind:npc.kind, hp:npc.hp, maxHp:npc.maxHp });
    const rm = [...removed];
    if (up.length||rm.length||npcUp.length) send(p.ws, { t:"DELTA", tick, up, rm, npcUp });
  }
  for (const p of players.values()) p.dirty = false;
  for (const npc of npcs.values()) npc.dirty = false;
  removed = new Set();
}, TICK_MS);

import { WebSocketServer } from 'ws';
import { findPathAStar } from './pathfinding.js';
import {
  defaultStats, deriveStats, statCost,
  expToNextLevel, STAT_POINTS_PER_LEVEL, EXP_TABLE,
  calcAtk, calcAspd, calcMaxHp, calcDef, calcCritRate
} from './stats.js';
import { ZONES, getZoneMap, checkPortal } from './zones.js';

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
const PORTAL_COOLDOWN_MS  = 2000; // prevent instant re-travel

let tick = 0;

// players: id -> player (with zoneId)
const players = new Map();
// npcs per zone: zoneId -> Map(id -> npc)
const zoneNpcs = {};
const zoneRemovedPlayers = {}; // zoneId -> Set of removed player ids this tick

for (const zid of Object.keys(ZONES)) {
  zoneNpcs[zid] = new Map();
  zoneRemovedPlayers[zid] = new Set();
}

function uid()   { return 'p_'   + Math.random().toString(36).slice(2,10); }
function npcId() { return 'npc_' + Math.random().toString(36).slice(2,10); }
function send(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function inAOI(a, b) {
  const dx=a.x-b.x, dy=a.y-b.y;
  return (dx*dx+dy*dy) <= AOI_RADIUS*AOI_RADIUS;
}
function dist(a,b) {
  const dx=a.x-b.x, dy=a.y-b.y;
  return Math.sqrt(dx*dx+dy*dy);
}

// Get players in a zone
function zonePlayers(zoneId) {
  const res = [];
  for (const p of players.values()) if (p.zoneId === zoneId) res.push(p);
  return res;
}

function snapshotFor(p) {
  const arr = [];
  for (const other of zonePlayers(p.zoneId))
    if (inAOI(p, other)) arr.push({ id:other.id, x:other.x, y:other.y, name:other.name, level:other.stats.level });
  return arr;
}
function npcSnapshotFor(p) {
  const arr = [];
  const npcs = zoneNpcs[p.zoneId] || new Map();
  for (const npc of npcs.values())
    if (!npc.isDead && inAOI(p, npc))
      arr.push({ id:npc.id, x:npc.x, y:npc.y, name:npc.name, kind:npc.kind, hp:npc.hp, maxHp:npc.maxHp });
  return arr;
}
function broadcastNearInZone(zoneId, pos, obj) {
  for (const p of zonePlayers(zoneId))
    if (inAOI(p, pos)) send(p.ws, obj);
}

// ── Spawn Porings per zone ──
const PORING_SPAWNS_BY_ZONE = {
  lerma:        [{ x:20,y:15 },{ x:25,y:18 },{ x:18,y:22 },{ x:30,y:25 },{ x:22,y:12 }],
  lerma_norte:  [{ x:20,y:20 },{ x:25,y:15 },{ x:10,y:30 },{ x:35,y:28 }],
  lerma_sur:    [{ x:25,y:25 },{ x:30,y:30 },{ x:10,y:35 },{ x:45,y:35 }],
  punta_banka:  [{ x:30,y:10 },{ x:35,y:25 },{ x:45,y:30 }],
  bagumbayan:   [{ x:25,y:25 },{ x:40,y:30 },{ x:20,y:30 },{ x:45,y:10 }],
};

for (const [zoneId, spawns] of Object.entries(PORING_SPAWNS_BY_ZONE)) {
  const map = getZoneMap(zoneId);
  for (const sp of spawns) {
    if (map.isBlocked(sp.x, sp.y)) continue;
    const id = npcId();
    zoneNpcs[zoneId].set(id, {
      id, kind:'poring', name:'Poring', zoneId,
      x:sp.x, y:sp.y, fx:sp.x, fy:sp.y,
      spawnX:sp.x, spawnY:sp.y,
      hp:PORING_MAX_HP, maxHp:PORING_MAX_HP,
      isDead:false, respawnAt:null,
      aggroTarget:null, lastNpcAtkAt:0, lastChaseAt:0,
      path:[], dirty:true,
      nextWanderAt: Date.now() + Math.random()*3000,
    });
  }
  console.log(`[LERMA] Zone ${zoneId}: spawned ${zoneNpcs[zoneId].size} Porings`);
}

// ── Migs NPC per zone ──
function spawnMigs(zoneId) {
  const zone = ZONES[zoneId];
  if (!zone || !zone.migs) return;
  const map = getZoneMap(zoneId);
  const { x, y } = zone.migs;
  if (map.isBlocked(x, y)) return;
  const id = 'migs_' + zoneId;
  zoneNpcs[zoneId].set(id, {
    id, kind:'migs', name:'Migs', zoneId,
    x, y, fx:x, fy:y, spawnX:x, spawnY:y,
    hp:9999, maxHp:9999,
    isDead:false, respawnAt:null,
    aggroTarget:null, lastNpcAtkAt:0, lastChaseAt:0,
    path:[], dirty:true, nextWanderAt:Infinity,
    isMigs:true,
  });
  console.log(`[LERMA] Migs spawned in ${zoneId} at (${x},${y})`);
}
for (const zid of Object.keys(ZONES)) spawnMigs(zid);

// ── Respawn check ──
setInterval(() => {
  const now = Date.now();
  for (const [zoneId, npcs] of Object.entries(zoneNpcs)) {
    for (const npc of npcs.values()) {
      if (npc.isMigs) continue;
      if (npc.isDead && npc.respawnAt && now >= npc.respawnAt) {
        npc.x=npc.spawnX; npc.y=npc.spawnY;
        npc.fx=npc.spawnX; npc.fy=npc.spawnY;
        npc.hp=npc.maxHp; npc.isDead=false; npc.respawnAt=null;
        npc.aggroTarget=null; npc.path=[]; npc.dirty=true;
        npc.nextWanderAt=Date.now()+1000;
        broadcastNearInZone(zoneId, npc, { t:'NPC_SPAWN', id:npc.id, x:npc.x, y:npc.y, name:npc.name, kind:npc.kind, hp:npc.hp, maxHp:npc.maxHp });
      }
    }
  }
}, 1000);

// ── Grant EXP ──
function grantExp(p, amount) {
  p.stats.exp += amount;
  while (p.stats.exp >= expToNextLevel(p.stats.level)) {
    p.stats.exp -= expToNextLevel(p.stats.level);
    p.stats.level++;
    p.stats.statPoints += STAT_POINTS_PER_LEVEL;
    p.hp = p.maxHp = calcMaxHp(p.stats.level, p.stats.vit);
    console.log(`[LERMA] ${p.name} reached level ${p.stats.level}!`);
    broadcastNearInZone(p.zoneId, p, { t:'PLAYER_LEVEL_UP', playerId:p.id, name:p.name, level:p.stats.level });
  }
  send(p.ws, { t:'STATS_UPDATE', stats:deriveStats(p.stats), hp:p.hp, maxHp:p.maxHp });
}

// ── Teleport player to a zone ──
function teleportPlayer(p, destZoneId, destX, destY) {
  const destZone = ZONES[destZoneId];
  if (!destZone) return;
  const destMap = getZoneMap(destZoneId);

  // Tell old zone players this player left
  for (const other of zonePlayers(p.zoneId)) {
    if (other.id !== p.id) send(other.ws, { t:'DELTA', tick, up:[], rm:[p.id], npcUp:[] });
  }

  // Move player
  p.zoneId = destZoneId;
  p.x = destX; p.y = destY;
  p.fx = destX; p.fy = destY;
  p.path = [];
  p.attackTarget = null;
  p.lastPortalAt = Date.now();

  // Send new zone info to player
  const newMap = destMap;
  send(p.ws, {
    t: 'ZONE_CHANGE',
    zoneId: destZoneId,
    zoneName: destZone.name,
    map: { w: newMap.w, h: newMap.h },
    x: destX, y: destY,
    players: snapshotFor(p),
    npcs: npcSnapshotFor(p),
    portals: destZone.portals,
  });

  // Tell new zone players this player appeared
  for (const other of zonePlayers(destZoneId)) {
    if (other.id !== p.id) {
      send(other.ws, { t:'DELTA', tick, up:[{ id:p.id, x:p.x, y:p.y, name:p.name, level:p.stats.level }], rm:[], npcUp:[] });
    }
  }

  console.log(`[LERMA] ${p.name} teleported to ${destZoneId} at (${destX},${destY})`);
}

// ── NPC AI ──
function tickZoneNPCs(zoneId) {
  const npcs = zoneNpcs[zoneId];
  const map  = getZoneMap(zoneId);
  const now  = Date.now();
  const zone_players = zonePlayers(zoneId);

  for (const npc of npcs.values()) {
    if (npc.isDead || npc.isMigs) continue;

    if (npc.aggroTarget) {
      const target = players.get(npc.aggroTarget);
      if (!target || target.zoneId !== zoneId || dist(npc,{x:npc.spawnX,y:npc.spawnY}) > LEASH_RANGE) {
        npc.aggroTarget=null; npc.path=[];
        npc.nextWanderAt=now+1000;
        const back = findPathAStar(map,npc.x,npc.y,npc.spawnX,npc.spawnY,300);
        if (back && back.length>1) npc.path=back.filter(s=>!(s.x===npc.x&&s.y===npc.y));
        broadcastNearInZone(zoneId,npc,{t:'NPC_LEASH',npcId:npc.id});
        continue;
      }
      const d = dist(npc,target);
      if (d <= ATTACK_RANGE) {
        npc.path=[];
        if (now-npc.lastNpcAtkAt >= PORING_ATK_COOLDOWN) {
          npc.lastNpcAtkAt=now;
          const def=calcDef(target.stats.vit);
          const dmg=Math.max(1,PORING_ATK_DMG+Math.floor(Math.random()*3)-def);
          target.hp=Math.max(0,target.hp-dmg);
          send(target.ws,{t:'PLAYER_HIT',dmg,hp:target.hp,maxHp:target.maxHp,attackerId:npc.id});
        }
      } else {
        if (now-npc.lastChaseAt>500||npc.path.length===0) {
          npc.lastChaseAt=now;
          const path=findPathAStar(map,npc.x,npc.y,target.x,target.y,300);
          if (path&&path.length>1) npc.path=path.filter(s=>!(s.x===npc.x&&s.y===npc.y));
        }
      }
    } else {
      if (npc.path.length===0&&now>=npc.nextWanderAt) {
        const tx=Math.max(0,Math.min(map.w-1,npc.x+Math.floor((Math.random()-0.5)*10)));
        const ty=Math.max(0,Math.min(map.h-1,npc.y+Math.floor((Math.random()-0.5)*10)));
        if (!map.isBlocked(tx,ty)) {
          const path=findPathAStar(map,npc.x,npc.y,tx,ty,200);
          if (path&&path.length>1) npc.path=path.filter(s=>!(s.x===npc.x&&s.y===npc.y));
        }
        npc.nextWanderAt=now+3000+Math.random()*5000;
      }
    }

    if (npc.path.length===0) continue;
    const next=npc.path[0];
    if (npc.x===next.x&&npc.y===next.y){npc.path.shift();continue;}
    const dx=Math.sign(next.x-npc.x), dy=Math.sign(next.y-npc.y);
    npc.fx+=dx*NPC_TILES_PER_TICK; npc.fy+=dy*NPC_TILES_PER_TICK;
    if (Math.abs(npc.fx-npc.x)>=1) {
      const nx=npc.x+dx;
      if (!map.isBlocked(nx,npc.y)){npc.x=nx;npc.dirty=true;}else npc.path=[];
      npc.fx=npc.x;
    }
    if (Math.abs(npc.fy-npc.y)>=1) {
      const ny=npc.y+dy;
      if (!map.isBlocked(npc.x,ny)){npc.y=ny;npc.dirty=true;}else npc.path=[];
      npc.fy=npc.y;
    }
  }
}

const wss = new WebSocketServer({ host:'127.0.0.1', port:3000 });
console.log('Secrets of Lerma Zone Server listening on ws://127.0.0.1:3000');

wss.on('connection', (ws) => {
  const id = uid();
  const defaultZone = ZONES.lerma;
  const defaultMap  = getZoneMap('lerma');

  const baseStats   = defaultStats();
  const startMaxHp  = calcMaxHp(baseStats.level, baseStats.vit);

  const p = {
    id, ws, name:'Traveler',
    zoneId:'lerma',
    x:defaultZone.defaultSpawn.x, y:defaultZone.defaultSpawn.y,
    fx:defaultZone.defaultSpawn.x, fy:defaultZone.defaultSpawn.y,
    path:[], dirty:true,
    lastMoveAt:0, lastAttackAt:0, lastChaseNpcAt:0,
    attackTarget:null, welcomed:false,
    lastPortalAt:0,
    stats:{...baseStats},
    hp:startMaxHp, maxHp:startMaxHp,
    respawnZone:'lerma',
    respawnX:defaultZone.defaultSpawn.x,
    respawnY:defaultZone.defaultSpawn.y,
  };

  players.set(id, p);
  send(ws, { t:'WELCOME', id, tick:TICK_HZ, map:{ w:defaultMap.w, h:defaultMap.h }, zoneId:'lerma', zoneName:defaultZone.name, portals:defaultZone.portals });

  ws.on('message', (buf) => {
    let msg;
    try { msg=JSON.parse(buf.toString()); } catch { return; }

    if (msg.t==='HELLO') {
      p.name=String(msg.name||'Traveler').slice(0,20);
      const sx=typeof msg.savedX==='number'?Math.floor(msg.savedX):null;
      const sy=typeof msg.savedY==='number'?Math.floor(msg.savedY):null;
      const sz=msg.savedZone||'lerma';

      // Restore zone
      if (ZONES[sz]) p.zoneId=sz;
      const map=getZoneMap(p.zoneId);

      if (sx!==null&&sy!==null&&sx>=0&&sy>=0&&sx<map.w&&sy<map.h&&!map.isBlocked(sx,sy)) {
        p.x=sx; p.fx=sx; p.y=sy; p.fy=sy;
      } else {
        const spawn=ZONES[p.zoneId].defaultSpawn;
        p.x=spawn.x; p.y=spawn.y; p.fx=spawn.x; p.fy=spawn.y;
      }

      // Restore stats
      if (msg.stats&&typeof msg.stats==='object') {
        const s=msg.stats;
        p.stats.level=Math.max(1,Math.min(99,s.level||1));
        p.stats.exp=Math.max(0,s.exp||0);
        p.stats.statPoints=Math.max(0,s.statPoints||0);
        for (const stat of ['str','agi','vit','int','dex','luk'])
          p.stats[stat]=Math.max(1,Math.min(99,s[stat]||1));
      }

      // Restore respawn point
      if (msg.respawnZone&&ZONES[msg.respawnZone]) {
        p.respawnZone=msg.respawnZone;
        p.respawnX=msg.respawnX||ZONES[msg.respawnZone].defaultSpawn.x;
        p.respawnY=msg.respawnY||ZONES[msg.respawnZone].defaultSpawn.y;
      }

      p.maxHp=calcMaxHp(p.stats.level,p.stats.vit);
      p.hp=p.maxHp;
      p.dirty=true;

      if (!p.welcomed) {
        p.welcomed=true;
        const zone=ZONES[p.zoneId];
        const map2=getZoneMap(p.zoneId);
        send(ws,{t:'SNAPSHOT',you:id,players:snapshotFor(p),npcs:npcSnapshotFor(p),zoneId:p.zoneId,zoneName:zone.name,map:{w:map2.w,h:map2.h},portals:zone.portals});
        send(ws,{t:'STATS_UPDATE',stats:deriveStats(p.stats),hp:p.hp,maxHp:p.maxHp});
        for (const other of zonePlayers(p.zoneId)) if (inAOI(p,other)) other.dirty=true;
      }
      return;
    }

    if (msg.t==='PING'){send(ws,{t:'PONG',ts:Date.now()});return;}

    if (msg.t==='MOVE_TO') {
      const now=Date.now();
      if (now-p.lastMoveAt<60)return;
      p.lastMoveAt=now;
      p.attackTarget=null;
      const tx=Math.floor(msg.x),ty=Math.floor(msg.y);
      const map=getZoneMap(p.zoneId);
      if (tx<0||ty<0||tx>=map.w||ty>=map.h)return;
      if (map.isBlocked(tx,ty))return;
      const path=findPathAStar(map,p.x,p.y,tx,ty,700);
      if (!path||path.length<2)return;
      p.path=path.filter(s=>!(s.x===p.x&&s.y===p.y));
      return;
    }

    if (msg.t==='ATTACK_NPC') {
      const npcs=zoneNpcs[p.zoneId];
      if (!npcs)return;
      const npc=npcs.get(msg.npcId);
      if (!npc||npc.isDead||npc.isMigs)return;
      p.attackTarget=msg.npcId;
      p.path=[];
      p.lastChaseNpcAt=0;
      if (!npc.aggroTarget){npc.aggroTarget=p.id;npc.path=[];broadcastNearInZone(p.zoneId,npc,{t:'NPC_AGGRO',npcId:npc.id});}
      return;
    }

    if (msg.t==='CANCEL_ATTACK'){p.attackTarget=null;return;}

    // ── Talk to Migs ──
    if (msg.t==='TALK_NPC') {
      const npcs=zoneNpcs[p.zoneId];
      if (!npcs)return;
      const npc=npcs.get(msg.npcId);
      if (!npc||!npc.isMigs)return;
      if (dist(p,npc)>3)return; // must be close

      const zone=ZONES[p.zoneId];
      send(p.ws,{
        t:'MIGS_MENU',
        npcId:npc.id,
        greeting:`Uy, ${p.name}! Kumusta ka? Ako si Migs, ang iyong pinagkakatiwalaang Kafra dito sa ${zone.name}. Ano ang kailangan mo?`,
        options:[
          { id:'save',    label:'💾 Save point dito (set respawn)' },
          { id:'teleport',label:'🌀 Teleport to another Migs' },
          { id:'storage', label:'📦 Access Storage (coming soon)' },
          { id:'close',   label:'👋 Salamat, Migs! Bye!' },
        ],
        destinations: zone.portals.map(po => ({ zoneId:po.destZone, label:ZONES[po.destZone]?.name || po.destZone })),
      });
      return;
    }

    // ── Migs action ──
    if (msg.t==='MIGS_ACTION') {
      if (msg.action==='save') {
        p.respawnZone=p.zoneId;
        p.respawnX=p.x;
        p.respawnY=p.y;
        send(p.ws,{t:'MIGS_RESPONSE',message:`Naka-save na! Kung mamatay ka, babalik ka dito sa ${ZONES[p.zoneId].name}. Ingat ha! 💾`});
        send(p.ws,{t:'RESPAWN_UPDATED',zone:p.zoneId,x:p.x,y:p.y});
        console.log(`[LERMA] ${p.name} set respawn at ${p.zoneId} (${p.x},${p.y})`);
      } else if (msg.action==='teleport'&&msg.destZone) {
        const dest=ZONES[msg.destZone];
        if (!dest){send(p.ws,{t:'MIGS_RESPONSE',message:'Hindi mahanap ang destinasyon...'});return;}
        send(p.ws,{t:'MIGS_RESPONSE',message:`Sige, idi-deliver kita sa Migs ng ${dest.name}! Huwag mabigo! 🌀`});
        setTimeout(()=>teleportPlayer(p,msg.destZone,dest.migs.x+1,dest.migs.y),500);
      } else if (msg.action==='storage') {
        send(p.ws,{t:'MIGS_RESPONSE',message:'Ay, wala pa akong storage ngayon. Balik ka mamaya! 😅'});
      }
      return;
    }

    if (msg.t==='ADD_STAT') {
      const stat=msg.stat;
      if (!['str','agi','vit','int','dex','luk'].includes(stat))return;
      const cost=statCost(p.stats[stat]);
      if (p.stats.statPoints<cost){send(p.ws,{t:'STAT_ERROR',msg:`Need ${cost} pts for ${stat.toUpperCase()}`});return;}
      p.stats.statPoints-=cost;
      p.stats[stat]++;
      if (stat==='vit'){const nm=calcMaxHp(p.stats.level,p.stats.vit);p.hp=Math.min(p.hp+(nm-p.maxHp),nm);p.maxHp=nm;}
      send(p.ws,{t:'STATS_UPDATE',stats:deriveStats(p.stats),hp:p.hp,maxHp:p.maxHp});
      return;
    }
  });

  ws.on('close', ()=>{
    for (const [,npcs] of Object.entries(zoneNpcs))
      for (const npc of npcs.values())
        if (npc.aggroTarget===id){npc.aggroTarget=null;npc.path=[];}
    zoneRemovedPlayers[p.zoneId].add(id);
    players.delete(id);
    for (const other of zonePlayers(p.zoneId)) other.dirty=true;
  });
});

// ── Auto attack tick ──
setInterval(()=>{
  const now=Date.now();
  for (const p of players.values()) {
    if (!p.attackTarget)continue;
    const npcs=zoneNpcs[p.zoneId];
    if (!npcs)continue;
    const npc=npcs.get(p.attackTarget);
    if (!npc||npc.isDead||npc.isMigs){p.attackTarget=null;continue;}
    const d=dist(p,npc);
    if (d>ATTACK_RANGE) {
      if (now-p.lastChaseNpcAt>400) {
        p.lastChaseNpcAt=now;
        const map=getZoneMap(p.zoneId);
        const path=findPathAStar(map,p.x,p.y,npc.x,npc.y,300);
        if (path&&path.length>1) p.path=path.filter(s=>!(s.x===p.x&&s.y===p.y));
      }
      continue;
    }
    p.path=[];
    const ac=calcAspd(p.stats.agi);
    if (now-p.lastAttackAt<ac)continue;
    p.lastAttackAt=now;
    const baseAtk=calcAtk(p.stats.level,p.stats.str);
    let dmg=baseAtk+Math.floor(Math.random()*5);
    let isCrit=false;
    if (Math.random()*100<calcCritRate(p.stats.luk)){dmg=Math.floor(dmg*CRIT_MULTIPLIER);isCrit=true;}
    npc.hp=Math.max(0,npc.hp-dmg);
    npc.dirty=true;
    broadcastNearInZone(p.zoneId,npc,{t:'NPC_HIT',npcId:npc.id,dmg,hp:npc.hp,maxHp:npc.maxHp,attackerId:p.id,isCrit});
    if (npc.hp<=0) {
      npc.isDead=true;npc.aggroTarget=null;npc.path=[];
      npc.respawnAt=now+PORING_RESPAWN_MS;
      p.attackTarget=null;
      broadcastNearInZone(p.zoneId,npc,{t:'NPC_DIED',npcId:npc.id,killerId:p.id});
      const expGain=EXP_TABLE[npc.kind]||15;
      grantExp(p,expGain);
      send(p.ws,{t:'EXP_GAIN',amount:expGain,total:p.stats.exp,next:expToNextLevel(p.stats.level)});
    }
  }
},100);

// ── Main tick ──
setInterval(()=>{
  tick++;

  // Move players + check portals
  for (const p of players.values()) {
    if (p.path.length===0)continue;
    const next=p.path[0];
    if (p.x===next.x&&p.y===next.y){p.path.shift();continue;}
    const dx=Math.sign(next.x-p.x),dy=Math.sign(next.y-p.y);
    p.fx+=dx*TILES_PER_TICK; p.fy+=dy*TILES_PER_TICK;
    const map=getZoneMap(p.zoneId);
    if (Math.abs(p.fx-p.x)>=1){
      const nx=p.x+dx;
      if (!map.isBlocked(nx,p.y)){p.x=nx;p.dirty=true;}else p.path=[];
      p.fx=p.x;
    }
    if (Math.abs(p.fy-p.y)>=1){
      const ny=p.y+dy;
      if (!map.isBlocked(p.x,ny)){p.y=ny;p.dirty=true;}else p.path=[];
      p.fy=p.y;
    }

    // Check portal
    if (p.dirty&&Date.now()-p.lastPortalAt>PORTAL_COOLDOWN_MS) {
      const portal=checkPortal(p.zoneId,p.x,p.y);
      if (portal) teleportPlayer(p,portal.destZone,portal.destX,portal.destY);
    }
  }

  // Move NPCs per zone
  for (const zid of Object.keys(ZONES)) tickZoneNPCs(zid);

  // Broadcast per zone
  for (const [zoneId, zone_player_list] of Object.entries({})) {} // unused
  for (const p of players.values()) {
    const up=[];
    for (const other of zonePlayers(p.zoneId))
      if (inAOI(p,other)&&other.dirty) up.push({id:other.id,x:other.x,y:other.y,name:other.name,level:other.stats.level});
    const npcUp=[];
    const npcs=zoneNpcs[p.zoneId]||new Map();
    for (const npc of npcs.values())
      if (!npc.isDead&&inAOI(p,npc)&&npc.dirty) npcUp.push({id:npc.id,x:npc.x,y:npc.y,name:npc.name,kind:npc.kind,hp:npc.hp,maxHp:npc.maxHp});
    const rm=[...( zoneRemovedPlayers[p.zoneId]||new Set())];
    if (up.length||rm.length||npcUp.length) send(p.ws,{t:'DELTA',tick,up,rm,npcUp});
  }

  for (const p of players.values()) p.dirty=false;
  for (const [,npcs] of Object.entries(zoneNpcs)) for (const npc of npcs.values()) npc.dirty=false;
  for (const zid of Object.keys(zoneRemovedPlayers)) zoneRemovedPlayers[zid]=new Set();

},TICK_MS);

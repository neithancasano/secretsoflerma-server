// ══════════════════════════════════════════════
// Lerma Zone Definitions
// ══════════════════════════════════════════════
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadZoneMap(filename) {
  const raw = readFileSync(join(__dirname, 'zones', filename), 'utf8');
  const data = JSON.parse(raw);
  // Build blocked set
  const blockedSet = new Set(data.blocked || []);
  return {
    w: data.w,
    h: data.h,
    tiles: data.tiles,
    blocked: blockedSet,
    isBlocked: (x, y) => blockedSet.has(`${x},${y}`),
  };
}

// Zone definitions
export const ZONES = {
  lerma: {
    id: 'lerma',
    name: 'Barangay Lerma',
    mapFile: 'map.json', // original map
    // Portals: { tile coords, destZone, destX, destY, label }
    portals: [
      { x: 15, y: 0,  destZone: 'lerma_norte',  destX: 15, destY: 38, label: 'Lerma Norte ↑' },
      { x: 15, y: 39, destZone: 'lerma_sur',    destX: 15, destY: 1,  label: 'Lerma Sur ↓' },
      { x: 0,  y: 20, destZone: 'punta_banka',  destX: 58, destY: 20, label: 'Punta Banka ←' },
      { x: 59, y: 20, destZone: 'bagumbayan',   destX: 1,  destY: 20, label: 'Bagumbayan →' },
    ],
    // Migs NPC spawn
    migs: { x: 16, y: 20 },
    // Default player spawn
    defaultSpawn: { x: 10, y: 10 },
  },
  lerma_norte: {
    id: 'lerma_norte',
    name: 'Lerma Norte',
    mapFile: 'lerma_norte.json',
    portals: [
      { x: 15, y: 39, destZone: 'lerma', destX: 15, destY: 1, label: 'Barangay Lerma ↓' },
    ],
    migs: { x: 16, y: 20 },
    defaultSpawn: { x: 15, y: 35 },
  },
  lerma_sur: {
    id: 'lerma_sur',
    name: 'Lerma Sur',
    mapFile: 'lerma_sur.json',
    portals: [
      { x: 15, y: 0, destZone: 'lerma', destX: 15, destY: 38, label: 'Barangay Lerma ↑' },
    ],
    migs: { x: 16, y: 20 },
    defaultSpawn: { x: 15, y: 5 },
  },
  punta_banka: {
    id: 'punta_banka',
    name: 'Punta Banka',
    mapFile: 'punta_banka.json',
    portals: [
      { x: 59, y: 20, destZone: 'lerma', destX: 1, destY: 20, label: 'Barangay Lerma →' },
    ],
    migs: { x: 31, y: 20 },
    defaultSpawn: { x: 35, y: 20 },
  },
  bagumbayan: {
    id: 'bagumbayan',
    name: 'Bagumbayan',
    mapFile: 'bagumbayan.json',
    portals: [
      { x: 0, y: 20, destZone: 'lerma', destX: 58, destY: 20, label: 'Barangay Lerma ←' },
    ],
    migs: { x: 16, y: 20 },
    defaultSpawn: { x: 5, y: 20 },
  },
};

// Cache loaded maps
const mapCache = {};

export function getZoneMap(zoneId) {
  if (mapCache[zoneId]) return mapCache[zoneId];
  const zone = ZONES[zoneId];
  if (!zone) throw new Error(`Unknown zone: ${zoneId}`);

  // lerma uses the root map.json, others use zones/
  let data;
  if (zoneId === 'lerma') {
    data = JSON.parse(readFileSync(join(__dirname, 'map.json'), 'utf8'));
  } else {
    data = JSON.parse(readFileSync(join(__dirname, 'zones', zone.mapFile), 'utf8'));
  }

  const blockedSet = new Set(data.blocked || []);
  const map = {
    w: data.w,
    h: data.h,
    tiles: data.tiles,
    isBlocked: (x, y) => blockedSet.has(`${x},${y}`),
  };
  mapCache[zoneId] = map;
  return map;
}

// Check if a tile is a portal and return portal def or null
export function checkPortal(zoneId, x, y) {
  const zone = ZONES[zoneId];
  if (!zone) return null;
  return zone.portals.find(p => p.x === x && p.y === y) || null;
}

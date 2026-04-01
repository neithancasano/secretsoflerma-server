// ══════════════════════════════════════════════
// Lerma Stats Engine — Classic RO Pre-renewal
// ══════════════════════════════════════════════

// Cost to raise a stat by 1 point (classic RO formula)
// Raising stat from N to N+1 costs floor(N/10) + 2 points
export function statCost(currentVal) {
  return Math.floor(currentVal / 10) + 2;
}

// EXP required to reach next level
// Level 1→2 needs 10, level 10→11 needs 1000
export function expToNextLevel(level) {
  return level * level * 10;
}

// Points awarded per level up
export const STAT_POINTS_PER_LEVEL = 5;

// EXP rewards per monster
export const EXP_TABLE = {
  poring: 15,
};

// Default stats for a new character
export function defaultStats() {
  return {
    level:      1,
    exp:        0,
    statPoints: 5, // start with 5 to spend
    str:        1,
    agi:        1,
    vit:        1,
    int:        1,
    dex:        1,
    luk:        1,
  };
}

// ── Derived stats from base stats ──
// These are calculated on the fly, never stored

export function calcMaxHp(level, vit) {
  // Base HP + VIT bonus (each VIT gives more HP as it grows)
  return 100 + (level - 1) * 20 + vit * 5 + Math.floor(vit / 5) * 10;
}

export function calcAtk(level, str) {
  // Base ATK + STR bonus
  return 8 + Math.floor(str / 5) + Math.floor(str * str / 100);
}

export function calcDef(vit) {
  // DEF from VIT
  return Math.floor(vit / 5);
}

export function calcAspd(agi) {
  // Attack speed (ms between attacks) — lower is faster
  // Base 1000ms, AGI reduces it. Min 400ms.
  return Math.max(400, 1000 - Math.floor(agi * 4));
}

export function calcHit(level, dex) {
  return level + dex;
}

export function calcFlee(level, agi) {
  return level + agi;
}

export function calcCritRate(luk) {
  // Crit chance % = luk / 3
  return Math.floor(luk / 3);
}

export function calcWeightLimit(str) {
  return 2000 + str * 30;
}

// Bundle all derived stats into one object for easy sending
export function deriveStats(s) {
  return {
    level:       s.level,
    exp:         s.exp,
    expNext:     expToNextLevel(s.level),
    statPoints:  s.statPoints,
    str: s.str, agi: s.agi, vit: s.vit,
    int: s.int, dex: s.dex, luk: s.luk,
    // Derived
    maxHp:       calcMaxHp(s.level, s.vit),
    atk:         calcAtk(s.level, s.str),
    def:         calcDef(s.vit),
    aspd:        calcAspd(s.agi),
    hit:         calcHit(s.level, s.dex),
    flee:        calcFlee(s.level, s.agi),
    critRate:    calcCritRate(s.luk),
    weightLimit: calcWeightLimit(s.str),
  };
}

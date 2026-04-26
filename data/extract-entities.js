/**
 * extract-entities.js
 *
 * Walks the Hytale reference-assets NPC directory tree and produces:
 *   - data/entities.json  (pretty-printed JSON array)
 *   - data/entities.js    (inline JS: const ENTITIES = [...];)
 *
 * Run:  node data/extract-entities.js
 */

const fs = require('fs');
const path = require('path');

// ── paths ────────────────────────────────────────────────────────────────────
const ASSETS_ROOT = path.resolve(
  __dirname,
  '../../../Agenten_Testbereich/MMO-Scruby-Companion-Superpowers/vendor/hytale/reference-assets/Server/NPC'
);
const ROLES_DIR    = path.join(ASSETS_ROOT, 'Roles');
const BEACONS_DIR  = path.join(ASSETS_ROOT, 'Spawn', 'Beacons');
const MARKERS_DIR  = path.join(ASSETS_ROOT, 'Spawn', 'Markers');
const OUT_JSON     = path.join(__dirname, 'entities.json');
const OUT_JS       = path.join(__dirname, 'entities.js');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Recursively collect all .json files under `dir`. */
function walkJson(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkJson(full));
    } else if (entry.name.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

/** Try to parse a JSON file; return null on failure. */
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Behaviour-skip directories (not meaningful subcategories). */
const BEHAVIOR_DIRS = new Set(['Aggressive', 'Passive', 'Neutral']);

/** Directories to skip entirely inside Roles/. */
const SKIP_DIRS = new Set(['_Core']);

/** Filename prefixes to skip. */
const SKIP_PREFIXES = ['Template_', 'Tamed_', 'Component_', 'Edible_'];

// ── 1. Extract roles ────────────────────────────────────────────────────────

function extractRoles() {
  const entities = new Map(); // id -> entity object

  const allFiles = walkJson(ROLES_DIR);

  for (const filePath of allFiles) {
    const fileName = path.basename(filePath, '.json');

    // Skip unwanted files
    if (fileName === 'Empty_Role') continue;
    if (SKIP_PREFIXES.some(p => fileName.startsWith(p))) continue;

    // Relative path from Roles/ dir  (e.g. Intelligent/Aggressive/Goblin/Goblin_Scrapper.json)
    const rel = path.relative(ROLES_DIR, filePath).replace(/\\/g, '/');
    const parts = rel.split('/');

    // Skip _Core directory
    if (parts[0] && SKIP_DIRS.has(parts[0])) continue;

    // Skip files inside Components/ or Templates/ subdirectories
    if (parts.some(p => p === 'Components' || p === 'Templates' || p === 'Tamed')) continue;

    // Category = first directory under Roles/
    const category = parts[0] || 'Unknown';

    // Directory parts between category and filename (excluding the file itself)
    const dirParts = parts.slice(1, -1);

    // Derive behavior from directory path
    let behaviorFromDir = null;
    for (const d of dirParts) {
      if (d === 'Aggressive') { behaviorFromDir = 'hostile'; break; }
      if (d === 'Passive')    { behaviorFromDir = 'passive'; break; }
      if (d === 'Neutral')    { behaviorFromDir = 'neutral'; break; }
    }

    // Subcategory = deepest meaningful directory (skip behavior dirs)
    const meaningfulDirs = dirParts.filter(d => !BEHAVIOR_DIRS.has(d));
    // Also skip "Dungeon" directories for subcategory — they are spawn variants
    const subcategory = meaningfulDirs.length > 0
      ? meaningfulDirs[meaningfulDirs.length - 1]
      : null;

    // Parse JSON
    const data = readJson(filePath);
    const modify = data?.Modify || {};

    // HP
    const hp = typeof modify.MaxHealth === 'number' ? modify.MaxHealth : null;

    // Tameable
    const tameable = modify.IsTameable === true ? true : null;

    // Weapons
    const weapons = Array.isArray(modify.Weapons) && modify.Weapons.length > 0
      ? modify.Weapons
      : null;

    // AttitudeGroup fallback for behavior
    const attitudeGroup = modify.AttitudeGroup || null;

    // Derive final behavior
    let behavior = deriveBehavior(behaviorFromDir, category, attitudeGroup);

    const entity = {
      id: fileName,
      category,
      subcategory,
      behavior,
      hp,
      tameable,
      weapons,
      zones: []
    };

    // Prefer the first occurrence (non-Dungeon variant)
    if (!entities.has(fileName)) {
      entities.set(fileName, entity);
    }
  }

  return entities;
}

/**
 * Derive behavior string from directory hint, category, and attitude group.
 */
function deriveBehavior(dirBehavior, category, attitudeGroup) {
  // 1. Explicit directory wins
  if (dirBehavior) return dirBehavior;

  // 2. Category defaults
  if (category === 'Boss')   return 'boss';
  if (category === 'Void')   return 'hostile';
  if (category === 'Undead') return 'hostile';

  // 3. AttitudeGroup fallback
  if (attitudeGroup) {
    const ag = attitudeGroup.toLowerCase();
    if (ag.includes('prey') || ag.includes('passive') || ag.includes('critter')
        || ag.includes('fish') || ag.includes('livestock')) {
      return 'passive';
    }
    if (ag.includes('predator') || ag.includes('void') || ag.includes('golem')
        || ag.includes('hostile') || ag.includes('aggressive')) {
      return 'hostile';
    }
    if (ag.includes('neutral')) return 'neutral';
  }

  // 4. Category-level defaults
  if (category === 'Creature') return 'passive';
  if (category === 'Aquatic')  return 'passive';
  if (category === 'Avian')    return 'passive';
  if (category === 'Elemental') return 'hostile';

  return 'unknown';
}

// ── 2. Extract zone mappings from Beacons ───────────────────────────────────

function extractBeaconZones() {
  // Map: entityId -> Set of zone strings
  const zoneMap = new Map();

  // Zone directories
  for (const zoneDirName of ['Zone1', 'Zone2', 'Zone3', 'Zone4']) {
    const zoneDir = path.join(BEACONS_DIR, zoneDirName);
    if (!fs.existsSync(zoneDir)) continue;

    const zoneLabel = zoneDirName.replace('Zone', 'Zone ');
    const files = walkJson(zoneDir);

    for (const filePath of files) {
      const data = readJson(filePath);
      if (!data || !Array.isArray(data.NPCs)) continue;

      for (const npc of data.NPCs) {
        const id = npc.Id || npc.Name;
        if (!id) continue;
        if (!zoneMap.has(id)) zoneMap.set(id, new Set());
        zoneMap.get(id).add(zoneLabel);
      }
    }
  }

  // Portal spawns
  const portalsDir = path.join(BEACONS_DIR, 'Portals');
  if (fs.existsSync(portalsDir)) {
    const files = walkJson(portalsDir);
    for (const filePath of files) {
      const data = readJson(filePath);
      if (!data || !Array.isArray(data.NPCs)) continue;

      for (const npc of data.NPCs) {
        const id = npc.Id || npc.Name;
        if (!id) continue;
        if (!zoneMap.has(id)) zoneMap.set(id, new Set());
        zoneMap.get(id).add('Portal');
      }
    }
  }

  // Top-level beacon files (e.g. Edible_Goblin_Scrapper.json, Goblin_Duke_Phase_*.json)
  const topLevelFiles = fs.readdirSync(BEACONS_DIR, { withFileTypes: true })
    .filter(e => !e.isDirectory() && e.name.endsWith('.json'));
  for (const entry of topLevelFiles) {
    const filePath = path.join(BEACONS_DIR, entry.name);
    const data = readJson(filePath);
    if (!data || !Array.isArray(data.NPCs)) continue;

    for (const npc of data.NPCs) {
      const id = npc.Id || npc.Name;
      if (!id) continue;
      if (!zoneMap.has(id)) zoneMap.set(id, new Set());
      zoneMap.get(id).add('World');
    }
  }

  return zoneMap;
}

// ── 3. Extract marker spawns ────────────────────────────────────────────────

function extractMarkerZones() {
  const zoneMap = new Map();
  const files = walkJson(MARKERS_DIR);

  for (const filePath of files) {
    const data = readJson(filePath);
    if (!data || !Array.isArray(data.NPCs)) continue;

    for (const npc of data.NPCs) {
      const id = npc.Id || npc.Name;
      if (!id) continue;
      if (!zoneMap.has(id)) zoneMap.set(id, new Set());
      zoneMap.get(id).add('World');
    }
  }

  return zoneMap;
}

// ── 4. Merge and output ─────────────────────────────────────────────────────

function main() {
  console.log('Extracting entity data from reference assets...\n');
  console.log(`Roles dir:   ${ROLES_DIR}`);
  console.log(`Beacons dir: ${BEACONS_DIR}`);
  console.log(`Markers dir: ${MARKERS_DIR}\n`);

  // 1. Roles
  const entities = extractRoles();
  console.log(`Roles extracted: ${entities.size} entities\n`);

  // 2. Beacon zones
  const beaconZones = extractBeaconZones();
  console.log(`Beacon zone mappings: ${beaconZones.size} entity IDs\n`);

  // 3. Marker zones
  const markerZones = extractMarkerZones();
  console.log(`Marker zone mappings: ${markerZones.size} entity IDs\n`);

  // Merge zones into entities
  let zoneMergeCount = 0;
  for (const [id, entity] of entities) {
    const zones = new Set();
    if (beaconZones.has(id)) {
      for (const z of beaconZones.get(id)) zones.add(z);
    }
    if (markerZones.has(id)) {
      for (const z of markerZones.get(id)) zones.add(z);
    }
    // Sort zones in a natural order
    const zoneOrder = ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4', 'Portal', 'World'];
    entity.zones = [...zones].sort((a, b) => zoneOrder.indexOf(a) - zoneOrder.indexOf(b));
    if (entity.zones.length > 0) zoneMergeCount++;
  }
  console.log(`Entities with zone data: ${zoneMergeCount}\n`);

  // Convert to sorted array
  const result = [...entities.values()].sort((a, b) => a.id.localeCompare(b.id));

  // Ensure all 8 keys present on every entity
  const cleaned = result.map(e => ({
    id: e.id,
    category: e.category,
    subcategory: e.subcategory || '',
    behavior: e.behavior,
    hp: e.hp !== null && e.hp !== undefined ? e.hp : null,
    tameable: e.tameable || false,
    weapons: e.weapons || [],
    zones: e.zones || []
  }));

  // Write JSON
  fs.writeFileSync(OUT_JSON, JSON.stringify(cleaned, null, 2), 'utf8');
  console.log(`Written: ${OUT_JSON}`);

  // Write JS (inline array)
  const jsContent = `// Auto-generated by extract-entities.js — do not edit manually\nconst ENTITIES = ${JSON.stringify(cleaned, null, 2)};\n`;
  fs.writeFileSync(OUT_JS, jsContent, 'utf8');
  console.log(`Written: ${OUT_JS}\n`);

  // Summary
  console.log('=== Category Summary ===');
  const categories = {};
  for (const e of cleaned) {
    categories[e.category] = (categories[e.category] || 0) + 1;
  }
  for (const [cat, count] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }
  console.log(`\n  TOTAL: ${cleaned.length} entities`);

  // Behavior breakdown
  console.log('\n=== Behavior Summary ===');
  const behaviors = {};
  for (const e of cleaned) {
    behaviors[e.behavior] = (behaviors[e.behavior] || 0) + 1;
  }
  for (const [beh, count] of Object.entries(behaviors).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${beh}: ${count}`);
  }

  // Zone breakdown
  console.log('\n=== Zone Summary ===');
  const zoneCounts = {};
  for (const e of cleaned) {
    for (const z of e.zones) {
      zoneCounts[z] = (zoneCounts[z] || 0) + 1;
    }
  }
  for (const [zone, count] of Object.entries(zoneCounts).sort()) {
    console.log(`  ${zone}: ${count}`);
  }

  const noZone = cleaned.filter(e => e.zones.length === 0).length;
  console.log(`  (no zone data): ${noZone}`);
}

main();

// ─── DNO Save File Binary Parser ─────────────────────────────────────────────
// Port of dno_stats.py's .NET BinaryFormatter parsing to client-side JavaScript.
// Operates on Uint8Array (from FileReader.readAsArrayBuffer).

// ─── Constants ───────────────────────────────────────────────────────────────

const DIFFICULTY_NAMES = { 0: 'Easy', 1: 'Normal', 2: 'Hard', 3: 'Brutal', 4: 'Impossible' };

// BinaryFormatter type tags
const TAG_PRIMITIVE = 0;
const TAG_STRING = 1;
const TAG_SYSTEM_CLASS = 3;
const TAG_CLASS = 4;
const TAG_PRIMITIVE_ARRAY = 7;

// .NET primitive type codes
const PRIM_BOOLEAN = 1;
const PRIM_BYTE = 2;
const PRIM_INT16 = 7;
const PRIM_INT32 = 8;
const PRIM_INT64 = 9;
const PRIM_SINGLE = 11;
const PRIM_DOUBLE = 6;

// ─── Core Binary Primitives ──────────────────────────────────────────────────

function parse7BitInt(data, offset) {
  let result = 0, shift = 0;
  while (true) {
    const b = data[offset++];
    result |= (b & 0x7F) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value: result, offset };
}

function parseBfString(data, offset) {
  const len = parse7BitInt(data, offset);
  offset = len.offset;
  const str = new TextDecoder().decode(data.subarray(offset, offset + len.value));
  return { value: str, offset: offset + len.value };
}

function readPrimitive(data, offset, primType) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (primType) {
    case PRIM_BOOLEAN: return { value: data[offset] !== 0, offset: offset + 1 };
    case PRIM_BYTE:    return { value: data[offset], offset: offset + 1 };
    case PRIM_INT16:   return { value: dv.getInt16(offset, true), offset: offset + 2 };
    case PRIM_INT32:   return { value: dv.getInt32(offset, true), offset: offset + 4 };
    case PRIM_INT64:   return { value: Number(dv.getBigInt64(offset, true)), offset: offset + 8 };
    case PRIM_SINGLE:  return { value: dv.getFloat32(offset, true), offset: offset + 4 };
    case PRIM_DOUBLE:  return { value: dv.getFloat64(offset, true), offset: offset + 8 };
    default: throw new Error(`Unknown primitive type: ${primType}`);
  }
}

// ─── Byte Search Helper ─────────────────────────────────────────────────────

function findBytes(data, needle, start = 0) {
  outer: for (let i = start; i <= data.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (data[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// ─── Class Finder ────────────────────────────────────────────────────────────

function findClassDefinition(data, className, expectedFields, start = 0) {
  const encoder = new TextEncoder();
  const classNameBytes = encoder.encode(className);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = start;

  while (true) {
    pos = findBytes(data, classNameBytes, pos);
    if (pos === -1) return null;

    const after = pos + classNameBytes.length;
    try {
      // Read member count (4 bytes LE unsigned)
      const mc = dv.getUint32(after, true);
      if (mc !== expectedFields.length) { pos++; continue; }

      // Validate first field name
      let testOffset = after + 4;
      const firstName = parseBfString(data, testOffset);
      if (firstName.value !== expectedFields[0]) { pos++; continue; }

      // Read all member names
      let offset = after + 4;
      const members = [];
      for (let i = 0; i < mc; i++) {
        const name = parseBfString(data, offset);
        members.push(name.value);
        offset = name.offset;
      }

      // Read type tags (1 byte each)
      const typeTags = [];
      for (let i = 0; i < mc; i++) {
        typeTags.push(data[offset++]);
      }

      // Read additional type info based on each tag
      const primTypes = new Array(mc).fill(0);
      for (let i = 0; i < mc; i++) {
        const tag = typeTags[i];
        if (tag === TAG_PRIMITIVE) {
          primTypes[i] = data[offset++];
        } else if (tag === TAG_CLASS) {
          const s = parseBfString(data, offset);
          offset = s.offset + 4; // skip assembly ref ID
        } else if (tag === TAG_SYSTEM_CLASS) {
          const s = parseBfString(data, offset);
          offset = s.offset;
        } else if (tag === TAG_PRIMITIVE_ARRAY) {
          primTypes[i] = data[offset++];
        }
        // TAG_STRING: no additional info
      }

      // Skip library ID (4 bytes)
      offset += 4;

      // Back-walk to find object ID
      let objectId = 0;
      try {
        let testPos = pos - 1;
        const limit = Math.max(pos - 50, 0);
        while (testPos >= limit) {
          try {
            const testLen = parse7BitInt(data, testPos);
            const end = testLen.offset;
            if (end + testLen.value <= data.length) {
              const fullStr = new TextDecoder().decode(data.subarray(end, end + testLen.value));
              if (fullStr.endsWith(className)) {
                objectId = dv.getUint32(testPos - 4, true);
                break;
              }
            }
          } catch (_) { /* ignore */ }
          testPos--;
        }
      } catch (_) { /* ignore */ }

      return {
        className, memberCount: mc, memberNames: members,
        typeTags, primTypes, dataOffset: offset, objectId,
      };
    } catch (_) { /* ignore, try next occurrence */ }
    pos++;
  }
}

function findClassIdInstance(data, metadataId, start = 0) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = start;
  while (pos < data.length - 9) {
    pos = data.indexOf(0x01, pos);
    if (pos === -1) return null;
    if (pos + 9 <= data.length) {
      const candidateMeta = dv.getUint32(pos + 5, true);
      if (candidateMeta === metadataId) {
        return pos + 9;
      }
    }
    pos++;
  }
  return null;
}

function findAllClassIdInstances(data, metadataId, start = 0) {
  const results = [];
  let pos = start;
  while (true) {
    const offset = findClassIdInstance(data, metadataId, pos);
    if (offset === null) break;
    results.push(offset);
    pos = offset;
  }
  return results;
}

// ─── Extraction Functions ────────────────────────────────────────────────────

function extractHeader(datData) {
  const expected = [
    'saveVersion', 'missionId', 'difficultyId', 'profileData',
    'specialHeaderValue', 'customMapName', 'completedCampaignLinks',
  ];
  let cdef = findClassDefinition(datData, 'ProfileSaveHeader', expected);
  if (!cdef) cdef = findClassDefinition(datData, 'UI.ProfileSaveHeader', expected);
  if (!cdef) return null;

  const dv = new DataView(datData.buffer, datData.byteOffset, datData.byteLength);
  let offset = cdef.dataOffset;
  const saveVersion = dv.getInt32(offset, true); offset += 4;
  const missionId = dv.getInt32(offset, true); offset += 4;
  const difficultyId = dv.getInt32(offset, true);

  return {
    saveVersion,
    missionId,
    missionIdName: null, // no mission map in browser
    difficultyId,
    difficultyName: DIFFICULTY_NAMES[difficultyId] || `Unknown(${difficultyId})`,
  };
}

function extractKilledEnemies(data) {
  const cdef = findClassDefinition(data, 'KilledEnemiesCounterSingleton', ['value']);
  if (!cdef) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return dv.getInt32(cdef.dataOffset, true);
}

function extractSessionTime(data) {
  const expected = [
    'nightIntensity', 'elapsedTime', 'elapsedTimeUnscaled',
    'previousFrameElapsedTime', 'timeSpeed', 'lastTimeSpeed', 'dirty',
  ];
  const cdef = findClassDefinition(data, 'CurrentSessionTimeSingleton', expected);
  if (!cdef) return null;

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = cdef.dataOffset;
  offset += 4; // skip nightIntensity
  const elapsedTime = dv.getFloat32(offset, true); offset += 4;
  const elapsedTimeUnscaled = dv.getFloat32(offset, true);

  return {
    gameSeconds: Math.round(elapsedTime * 10) / 10,
    realSeconds: Math.round(elapsedTimeUnscaled * 10) / 10,
    gameFormatted: formatDuration(elapsedTime),
    realFormatted: formatDuration(elapsedTimeUnscaled),
  };
}

function extractResources(data) {
  const expected = [
    'foodByFarms', 'foodByFishers', 'foodByBerrypickers', 'wood',
    'treesCutted', 'treesPlanted', 'stone', 'iron',
    'woodConsuming', 'ironConsuming',
  ];
  const cdef = findClassDefinition(data, 'ResourcesStatisticContainer', expected);
  if (!cdef) return null;

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const result = {};

  // Current day
  let offset = cdef.dataOffset;
  const currentDay = {};
  for (const name of expected) {
    currentDay[name] = dv.getInt32(offset, true);
    offset += 4;
  }
  result.currentDay = currentDay;

  // Last day via ClassWithId back-reference
  if (cdef.objectId !== 0) {
    const cidOffset = findClassIdInstance(data, cdef.objectId, offset);
    if (cidOffset !== null) {
      const lastDay = {};
      let off2 = cidOffset;
      for (const name of expected) {
        lastDay[name] = dv.getInt32(off2, true);
        off2 += 4;
      }
      result.lastDay = lastDay;
    }
  }

  return result;
}

function extractUndeadResources(data) {
  const expected = [
    'zombiesByBurial', 'zombiesByCorpses', 'deathMetal', 'spirit', 'bones',
  ];
  const cdef = findClassDefinition(data, 'UndeadResourcesStatisticContainer', expected);
  if (!cdef) return null;

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const result = {};

  let offset = cdef.dataOffset;
  const currentDay = {};
  for (const name of expected) {
    currentDay[name] = dv.getInt32(offset, true);
    offset += 4;
  }
  result.currentDay = currentDay;

  if (cdef.objectId !== 0) {
    const cidOffset = findClassIdInstance(data, cdef.objectId, offset);
    if (cidOffset !== null) {
      const lastDay = {};
      let off2 = cidOffset;
      for (const name of expected) {
        lastDay[name] = dv.getInt32(off2, true);
        off2 += 4;
      }
      result.lastDay = lastDay;
    }
  }

  return result;
}

function extractAchievements(data) {
  const expected = [
    'gatheredGold', 'lastGold', 'siegeMachineWasTrained',
    'powerUndeadUnitsWasTrained', 'portsDestroyed',
    'marketPartsDestroyed', 'trainedUnitTypes',
  ];
  const cdef = findClassDefinition(data, 'AchievementsSaveData', expected);
  if (!cdef) return null;

  let offset = cdef.dataOffset;
  const result = {};
  for (let i = 0; i < expected.length; i++) {
    const tag = cdef.typeTags[i];
    if (tag !== TAG_PRIMITIVE) break; // stop at non-primitive (trainedUnitTypes)
    const prim = cdef.primTypes[i];
    const r = readPrimitive(data, offset, prim);
    result[expected[i]] = r.value;
    offset = r.offset;
  }
  return result;
}

function extractWaves(data) {
  const expected = ['referenceId', 'waveId', 'mapped', 'fullySpawned', 'waveDestroyed', 'major'];
  const cdef = findClassDefinition(data, 'WaveHolderSaveData', expected);
  if (!cdef) return null;

  const waves = [];

  // Read first wave
  const first = readWaveFields(data, cdef.dataOffset, cdef);
  if (first) waves.push(first);

  // Find subsequent waves via ClassWithId back-references
  if (cdef.objectId !== 0) {
    for (const cidOffset of findAllClassIdInstances(data, cdef.objectId, cdef.dataOffset)) {
      const wave = readWaveFields(data, cidOffset, cdef);
      if (wave) waves.push(wave);
    }
  }

  if (waves.length === 0) return null;

  return {
    total: waves.length,
    destroyed: waves.filter(w => w.waveDestroyed).length,
    majorWaves: waves.filter(w => w.major).length,
    details: waves,
  };
}

function readWaveFields(data, offset, cdef) {
  const wave = {};
  try {
    for (let i = 0; i < cdef.memberNames.length; i++) {
      const tag = cdef.typeTags[i];
      if (tag !== TAG_PRIMITIVE) break;
      const prim = cdef.primTypes[i];
      const r = readPrimitive(data, offset, prim);
      wave[cdef.memberNames[i]] = r.value;
      offset = r.offset;
    }
    return wave;
  } catch (_) {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

async function parseSaveFiles(saveFile, datFile) {
  const [saveBuffer, datBuffer] = await Promise.all([
    saveFile.arrayBuffer(),
    datFile.arrayBuffer(),
  ]);

  const saveData = new Uint8Array(saveBuffer);
  const datData = new Uint8Array(datBuffer);
  const errors = [];

  let header = null, enemiesKilled = null, sessionTime = null;
  let resources = null, undeadResources = null, achievements = null, waves = null;

  try { header = extractHeader(datData); } catch (e) { errors.push('header: ' + e.message); }
  try { enemiesKilled = extractKilledEnemies(saveData); } catch (e) { errors.push('enemiesKilled: ' + e.message); }
  try { sessionTime = extractSessionTime(saveData); } catch (e) { errors.push('sessionTime: ' + e.message); }
  try { resources = extractResources(saveData); } catch (e) { errors.push('resources: ' + e.message); }
  try { undeadResources = extractUndeadResources(saveData); } catch (e) { errors.push('undeadResources: ' + e.message); }
  try { achievements = extractAchievements(saveData); } catch (e) { errors.push('achievements: ' + e.message); }
  try { waves = extractWaves(saveData); } catch (e) { errors.push('waves: ' + e.message); }

  const statistics = {};
  if (enemiesKilled !== null) statistics.enemiesKilled = enemiesKilled;
  if (sessionTime !== null) statistics.sessionTime = sessionTime;
  if (resources !== null) statistics.resources = resources;
  if (undeadResources !== null) statistics.undeadResources = undeadResources;
  if (achievements !== null) statistics.achievements = achievements;
  if (waves !== null) statistics.waves = waves;

  const saveEntry = {
    fileName: saveFile.name,
    fileSize: saveFile.size,
    lastModified: new Date(saveFile.lastModified).toISOString(),
    statistics,
  };
  if (header) saveEntry.header = header;
  if (errors.length) saveEntry.errors = errors;

  return {
    extractorVersion: 'browser-1.0',
    extractedAt: new Date().toISOString(),
    missionMap: null,
    profiles: [{
      name: 'Uploaded Save',
      isActive: true,
      profileData: { completedMissionsData: [], campaignProfiles: [] },
      saves: [saveEntry],
    }],
  };
}

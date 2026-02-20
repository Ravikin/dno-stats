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
  if (!cdef) {
    console.log('[header] ProfileSaveHeader not found, trying UI.ProfileSaveHeader');
    cdef = findClassDefinition(datData, 'UI.ProfileSaveHeader', expected);
  }
  if (!cdef) {
    console.warn('[header] ProfileSaveHeader not found in .dat file');
    return null;
  }
  console.log('[header] Found class definition:', {
    className: cdef.className, dataOffset: cdef.dataOffset, objectId: cdef.objectId,
    memberNames: cdef.memberNames, typeTags: cdef.typeTags, primTypes: cdef.primTypes,
  });

  const dv = new DataView(datData.buffer, datData.byteOffset, datData.byteLength);
  let offset = cdef.dataOffset;
  const saveVersion = dv.getInt32(offset, true); offset += 4;
  const missionId = dv.getInt32(offset, true); offset += 4;
  const difficultyId = dv.getInt32(offset, true);

  const result = {
    saveVersion,
    missionId,
    missionIdName: null,
    difficultyId,
    difficultyName: DIFFICULTY_NAMES[difficultyId] || `Unknown(${difficultyId})`,
  };
  console.log('[header] Parsed:', result);
  return result;
}

function extractKilledEnemies(data) {
  const cdef = findClassDefinition(data, 'KilledEnemiesCounterSingleton', ['value']);
  if (!cdef) { console.warn('[enemies] KilledEnemiesCounterSingleton not found'); return null; }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const value = dv.getInt32(cdef.dataOffset, true);
  console.log('[enemies] Killed:', value);
  return value;
}

function extractSessionTime(data) {
  const expected = [
    'nightIntensity', 'elapsedTime', 'elapsedTimeUnscaled',
    'previousFrameElapsedTime', 'timeSpeed', 'lastTimeSpeed', 'dirty',
  ];
  const cdef = findClassDefinition(data, 'CurrentSessionTimeSingleton', expected);
  if (!cdef) { console.warn('[time] CurrentSessionTimeSingleton not found'); return null; }

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = cdef.dataOffset;
  offset += 4; // skip nightIntensity
  const elapsedTime = dv.getFloat32(offset, true); offset += 4;
  const elapsedTimeUnscaled = dv.getFloat32(offset, true);

  const result = {
    gameSeconds: Math.round(elapsedTime * 10) / 10,
    realSeconds: Math.round(elapsedTimeUnscaled * 10) / 10,
    gameFormatted: formatDuration(elapsedTime),
    realFormatted: formatDuration(elapsedTimeUnscaled),
  };
  console.log('[time] Session:', result);
  return result;
}

function extractResources(data) {
  const expected = [
    'foodByFarms', 'foodByFishers', 'foodByBerrypickers', 'wood',
    'treesCutted', 'treesPlanted', 'stone', 'iron',
    'woodConsuming', 'ironConsuming',
  ];
  const cdef = findClassDefinition(data, 'ResourcesStatisticContainer', expected);
  if (!cdef) { console.warn('[resources] ResourcesStatisticContainer not found'); return null; }
  console.log('[resources] Found at offset', cdef.dataOffset, 'objectId:', cdef.objectId);

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const result = {};

  let offset = cdef.dataOffset;
  const currentDay = {};
  for (const name of expected) {
    currentDay[name] = dv.getInt32(offset, true);
    offset += 4;
  }
  result.currentDay = currentDay;
  console.log('[resources] currentDay:', currentDay);

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
      console.log('[resources] lastDay:', lastDay);
    } else {
      console.warn('[resources] ClassWithId for lastDay not found (objectId:', cdef.objectId, ')');
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
  if (!cdef) { console.warn('[achievements] AchievementsSaveData not found'); return null; }

  let offset = cdef.dataOffset;
  const result = {};
  for (let i = 0; i < expected.length; i++) {
    const tag = cdef.typeTags[i];
    if (tag !== TAG_PRIMITIVE) break;
    const prim = cdef.primTypes[i];
    const r = readPrimitive(data, offset, prim);
    result[expected[i]] = r.value;
    offset = r.offset;
  }
  console.log('[achievements] Parsed:', result);
  return result;
}

function extractWaves(data) {
  const expected = ['referenceId', 'waveId', 'mapped', 'fullySpawned', 'waveDestroyed', 'major'];
  const cdef = findClassDefinition(data, 'WaveHolderSaveData', expected);
  if (!cdef) { console.log('[waves] No WaveHolderSaveData found (may be normal for early saves)'); return null; }

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
  console.group('[dno-parser] Parsing save files');
  console.log('Save file:', saveFile.name, `(${(saveFile.size / 1024).toFixed(1)} KB)`);
  console.log('Dat file:', datFile.name, `(${(datFile.size / 1024).toFixed(1)} KB)`);

  const [saveBuffer, datBuffer] = await Promise.all([
    saveFile.arrayBuffer(),
    datFile.arrayBuffer(),
  ]);

  const saveData = new Uint8Array(saveBuffer);
  const datData = new Uint8Array(datBuffer);
  const errors = [];

  let header = null, enemiesKilled = null, sessionTime = null;
  let resources = null, undeadResources = null, achievements = null, waves = null;

  try { header = extractHeader(datData); } catch (e) { console.error('[header] Exception:', e); errors.push('header: ' + e.message); }
  try { enemiesKilled = extractKilledEnemies(saveData); } catch (e) { console.error('[enemies] Exception:', e); errors.push('enemiesKilled: ' + e.message); }
  try { sessionTime = extractSessionTime(saveData); } catch (e) { console.error('[time] Exception:', e); errors.push('sessionTime: ' + e.message); }
  try { resources = extractResources(saveData); } catch (e) { console.error('[resources] Exception:', e); errors.push('resources: ' + e.message); }
  try { undeadResources = extractUndeadResources(saveData); } catch (e) { console.error('[undead] Exception:', e); errors.push('undeadResources: ' + e.message); }
  try { achievements = extractAchievements(saveData); } catch (e) { console.error('[achievements] Exception:', e); errors.push('achievements: ' + e.message); }
  try { waves = extractWaves(saveData); } catch (e) { console.error('[waves] Exception:', e); errors.push('waves: ' + e.message); }

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

  if (errors.length) console.warn('[dno-parser] Extraction errors:', errors);
  console.log('[dno-parser] Final save entry:', JSON.parse(JSON.stringify(saveEntry)));
  console.groupEnd();

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

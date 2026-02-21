#!/usr/bin/env python3
"""
DNO Save File Statistics Extractor

Extracts game statistics from "Diplomacy Is Not an Option" save files
into structured JSON. Save files use .NET BinaryFormatter serialization.

Usage:
    python3 dno_stats.py --data-root ~/path/to/DNOPersistentData --pretty
"""

import argparse
import json
import logging
import struct
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

__version__ = "1.0.0"

log = logging.getLogger("dno_stats")

# ─── Constants & ID Mapping Tables ────────────────────────────────────────────

DIFFICULTY_NAMES = {
    0: "Easy-Peasy Lemon Squeezy",
    1: "Almost a Walk in the Park",
    2: "Challenge Accepted",
    3: "Ultra-Hardcore",
    4: "Pure Insanity",
    5: "Your Worst Nightmare",
}
MISSION_TYPES = {0: "None", 1: "Campaign", 2: "Endless", 3: "Tutorial", 4: "Block", 5: "Sandbox", 6: "CustomMap"}
FACTIONS = {0: "Default", 1: "Undead"}

# BinaryFormatter type tags (MemberTypeInfo)
TAG_PRIMITIVE = 0
TAG_STRING = 1
TAG_SYSTEM_CLASS = 3
TAG_CLASS = 4
TAG_PRIMITIVE_ARRAY = 7

# .NET primitive type codes
PRIM_BOOLEAN = 1
PRIM_BYTE = 2
PRIM_INT16 = 7
PRIM_INT32 = 8
PRIM_INT64 = 9
PRIM_SINGLE = 11  # float32
PRIM_DOUBLE = 6   # float64

PRIM_SIZES = {
    PRIM_BOOLEAN: 1,
    PRIM_BYTE: 1,
    PRIM_INT16: 2,
    PRIM_INT32: 4,
    PRIM_INT64: 8,
    PRIM_SINGLE: 4,
    PRIM_DOUBLE: 8,
}

PRIM_FORMATS = {
    PRIM_BOOLEAN: '<?',
    PRIM_BYTE: '<B',
    PRIM_INT16: '<h',
    PRIM_INT32: '<i',
    PRIM_INT64: '<q',
    PRIM_SINGLE: '<f',
    PRIM_DOUBLE: '<d',
}


# ─── BinaryFormatterReader ────────────────────────────────────────────────────

def parse_7bit_int(data: bytes, offset: int) -> tuple[int, int]:
    """Parse a .NET 7-bit encoded integer (LEB128 variant). Returns (value, new_offset)."""
    result = 0
    shift = 0
    while True:
        b = data[offset]
        offset += 1
        result |= (b & 0x7F) << shift
        shift += 7
        if not (b & 0x80):
            break
    return result, offset


def parse_bf_string(data: bytes, offset: int) -> tuple[str, int]:
    """Parse a BinaryFormatter length-prefixed string. Returns (string, new_offset)."""
    str_len, offset = parse_7bit_int(data, offset)
    s = data[offset:offset + str_len].decode('utf-8', errors='replace')
    return s, offset + str_len


def read_primitive(data: bytes, offset: int, prim_type: int) -> tuple[Any, int]:
    """Read a primitive value of the given type. Returns (value, new_offset)."""
    fmt = PRIM_FORMATS.get(prim_type)
    size = PRIM_SIZES.get(prim_type)
    if fmt is None or size is None:
        raise ValueError(f"Unknown primitive type: {prim_type}")
    value = struct.unpack_from(fmt, data, offset)[0]
    return value, offset + size


# ─── ClassFinder ──────────────────────────────────────────────────────────────

@dataclass
class ClassDef:
    """Parsed BinaryFormatter class definition."""
    class_name: str
    member_count: int
    member_names: list[str]
    type_tags: list[int]
    prim_types: list[int]  # primitive type code per field (0 if not primitive)
    data_offset: int  # offset where field values start (after 4-byte object ref ID)
    object_id: int = 0  # object ID of this class definition (for ClassWithId matching)


def find_class_definition(
    data: bytes,
    class_name: str,
    expected_fields: list[str],
    start: int = 0,
) -> Optional[ClassDef]:
    """
    Find a ClassWithMembersAndTypes record by searching for class_name bytes,
    validating member count and first field name, then parsing through type tags
    and additional type info to locate the data offset.

    Returns ClassDef with data_offset pointing past the 4-byte object ref ID,
    or None if not found.
    """
    class_name_bytes = class_name.encode('utf-8')
    pos = start

    while True:
        pos = data.find(class_name_bytes, pos)
        if pos == -1:
            return None

        after = pos + len(class_name_bytes)
        try:
            # Read member count (4 bytes LE)
            mc = struct.unpack_from('<I', data, after)[0]
            if mc != len(expected_fields):
                pos += 1
                continue

            # Validate first field name
            test_offset = after + 4
            first_name, _ = parse_bf_string(data, test_offset)
            if first_name != expected_fields[0]:
                pos += 1
                continue

            # Read all member names
            offset = after + 4
            members = []
            for _ in range(mc):
                name, offset = parse_bf_string(data, offset)
                members.append(name)

            # Read type tags (1 byte each)
            type_tags = []
            for _ in range(mc):
                type_tags.append(data[offset])
                offset += 1

            # Read additional type info based on each tag
            prim_types = [0] * mc
            for i in range(mc):
                tag = type_tags[i]
                if tag == TAG_PRIMITIVE:
                    prim_types[i] = data[offset]
                    offset += 1
                elif tag == TAG_CLASS:
                    _, offset = parse_bf_string(data, offset)
                    offset += 4  # assembly ref ID
                elif tag == TAG_SYSTEM_CLASS:
                    _, offset = parse_bf_string(data, offset)
                elif tag == TAG_PRIMITIVE_ARRAY:
                    prim_types[i] = data[offset]
                    offset += 1
                elif tag == TAG_STRING:
                    pass  # no additional info
                # else: unknown tag, may cause issues

            # Skip library ID (4 bytes) at end of ClassWithMembersAndTypes
            offset += 4

            # The object ref ID was BEFORE the class name in the record:
            #   RecordType(1) | ObjectId(4) | ClassName(str) | MemberCount(4) | ...
            # We need to read it for ClassWithId matching.
            # Go back: class_name_bytes started at pos, length prefix is before that.
            # The 7-bit length prefix could be 1-2 bytes. ObjectId is 4 bytes before that.
            # Simplest: read the 4 bytes before the string length byte.
            str_len_bytes = len(class_name.encode('utf-8'))
            # Find how many bytes the 7-bit encoding of the full class name length takes
            # The search found class_name_bytes at pos, but the actual string may have a
            # prefix (e.g. "UI." or "Utility."). We need the full string length byte.
            # The length prefix starts some bytes before pos.
            # For now, read the ObjectId from 5 bytes before the length prefix position.
            # The length prefix position = pos - len(prefix) - num_7bit_bytes
            # This is complex; instead, just read 4 bytes at pos - len(prefix) - 1 - 4
            # where -1 is for the single-byte length prefix (works for strings < 128 bytes).
            #
            # Actually, the object ID is at a known position relative to the record start.
            # The record type byte 0x05 should be 1 byte before the object ID, which is
            # 4 bytes before the string length prefix.
            # Let's search backward for the string length prefix.
            obj_id = 0
            try:
                # Walk backward to find the 7-bit length prefix
                # The class name at pos is a substring; full string starts earlier
                # Look for the length byte that covers through pos + len(class_name_bytes)
                test_pos = pos - 1
                while test_pos > pos - 50 and test_pos >= 0:
                    try:
                        test_len, end = parse_7bit_int(data, test_pos)
                        full_str = data[end:end + test_len].decode('utf-8', errors='replace')
                        if full_str.endswith(class_name):
                            # Found the length prefix; object ID is 4 bytes before it
                            obj_id = struct.unpack_from('<I', data, test_pos - 4)[0]
                            break
                    except (IndexError, UnicodeDecodeError):
                        pass
                    test_pos -= 1
            except Exception:
                pass

            return ClassDef(
                class_name=class_name,
                member_count=mc,
                member_names=members,
                type_tags=type_tags,
                prim_types=prim_types,
                data_offset=offset,
                object_id=obj_id,
            )

        except (struct.error, IndexError, UnicodeDecodeError):
            pass

        pos += 1

    return None


def find_classid_instance(data: bytes, metadata_id: int, start: int = 0) -> Optional[int]:
    """Find a ClassWithId (record type 0x01) back-reference that points to a
    given metadata_id (the object ID of the original ClassWithMembersAndTypes).

    Returns the offset where field data values start (after ObjectId + MetadataId),
    or None if not found.

    ClassWithId format: RecordType(0x01) | ObjectId(4) | MetadataId(4) | field values
    """
    record_byte = b'\x01'
    metadata_bytes = struct.pack('<I', metadata_id)
    pos = start

    while pos < len(data) - 9:
        pos = data.find(record_byte, pos)
        if pos == -1:
            return None
        # Check if next 8 bytes have the right metadata ID at offset +5
        if pos + 9 <= len(data):
            candidate_meta = struct.unpack_from('<I', data, pos + 5)[0]
            if candidate_meta == metadata_id:
                return pos + 9  # skip RecordType(1) + ObjectId(4) + MetadataId(4)
        pos += 1

    return None


def find_all_classid_instances(data: bytes, metadata_id: int, start: int = 0) -> list[int]:
    """Find all ClassWithId back-references for a given metadata_id.
    Returns list of offsets where field data values start."""
    results = []
    pos = start
    while True:
        offset = find_classid_instance(data, metadata_id, pos)
        if offset is None:
            break
        results.append(offset)
        pos = offset
    return results


# ─── SaveFileParser ───────────────────────────────────────────────────────────

class SaveFileParser:
    """Extracts statistics from a single save file."""

    def __init__(self, save_path: Path):
        self.save_path = save_path
        self.dat_path = save_path.with_suffix('.dat') if not str(save_path).endswith('.dat') else None
        self.errors: list[str] = []
        self._data: Optional[bytes] = None
        self._dat_data: Optional[bytes] = None

    def _load_data(self) -> bytes:
        if self._data is None:
            self._data = self.save_path.read_bytes()
        return self._data

    def _load_dat_data(self) -> Optional[bytes]:
        if self._dat_data is None and self.dat_path and self.dat_path.exists():
            self._dat_data = self.dat_path.read_bytes()
        return self._dat_data

    def extract_all(self) -> dict:
        """Extract all available statistics from this save file."""
        result = {}

        extractors = [
            ("header", self._extract_header),
            ("enemiesKilled", self._extract_killed_enemies),
            ("sessionTime", self._extract_session_time),
            ("resources", self._extract_resource_stats),
            ("undeadResources", self._extract_undead_stats),
            ("achievements", self._extract_achievements),
            ("waves", self._extract_wave_holders),
        ]

        for key, extractor in extractors:
            try:
                value = extractor()
                if value is not None:
                    result[key] = value
            except Exception as e:
                err_msg = f"Error extracting {key}: {e}"
                log.warning(err_msg)
                self.errors.append(err_msg)

        return result

    def _extract_header(self) -> Optional[dict]:
        """Extract ProfileSaveHeader from the .dat file."""
        dat_data = self._load_dat_data()
        if dat_data is None:
            self.errors.append("No .dat file found")
            return None

        expected = [
            'saveVersion', 'missionId', 'difficultyId', 'profileData',
            'specialHeaderValue', 'customMapName', 'completedCampaignLinks',
        ]
        cdef = find_class_definition(dat_data, 'ProfileSaveHeader', expected)
        if cdef is None:
            # Try with UI. prefix
            cdef = find_class_definition(dat_data, 'UI.ProfileSaveHeader', expected)
        if cdef is None:
            self.errors.append("ProfileSaveHeader not found in .dat file")
            return None

        offset = cdef.data_offset
        save_version = struct.unpack_from('<i', dat_data, offset)[0]
        offset += 4
        mission_id = struct.unpack_from('<i', dat_data, offset)[0]
        offset += 4
        difficulty_id = struct.unpack_from('<i', dat_data, offset)[0]

        return {
            "saveVersion": save_version,
            "missionId": mission_id,
            "missionIdName": MISSION_MAP.get(mission_id, None),
            "difficultyId": difficulty_id,
            "difficultyName": DIFFICULTY_NAMES.get(difficulty_id, f"Unknown({difficulty_id})"),
        }

    def _extract_killed_enemies(self) -> Optional[int]:
        """Extract KilledEnemiesCounterSingleton.value (int32)."""
        data = self._load_data()

        # Fast path: search for the known byte pattern
        needle = b'KilledEnemiesCounterSingleton'
        expected = ['value']
        cdef = find_class_definition(data, 'KilledEnemiesCounterSingleton', expected)
        if cdef is None:
            self.errors.append("KilledEnemiesCounterSingleton not found")
            return None

        value = struct.unpack_from('<i', data, cdef.data_offset)[0]
        return value

    def _extract_session_time(self) -> Optional[dict]:
        """Extract CurrentSessionTimeSingleton fields."""
        data = self._load_data()

        expected = [
            'nightIntensity', 'elapsedTime', 'elapsedTimeUnscaled',
            'previousFrameElapsedTime', 'timeSpeed', 'lastTimeSpeed', 'dirty',
        ]
        cdef = find_class_definition(data, 'CurrentSessionTimeSingleton', expected)
        if cdef is None:
            self.errors.append("CurrentSessionTimeSingleton not found")
            return None

        offset = cdef.data_offset
        # First 4 fields are float32 (prim type 11)
        night_intensity = struct.unpack_from('<f', data, offset)[0]; offset += 4
        elapsed_time = struct.unpack_from('<f', data, offset)[0]; offset += 4
        elapsed_time_unscaled = struct.unpack_from('<f', data, offset)[0]; offset += 4

        return {
            "gameSeconds": round(elapsed_time, 1),
            "realSeconds": round(elapsed_time_unscaled, 1),
            "gameFormatted": _format_duration(elapsed_time),
            "realFormatted": _format_duration(elapsed_time_unscaled),
        }

    def _extract_resource_stats(self) -> Optional[dict]:
        """Extract ResourcesStatisticContainer fields (10 int32s).

        There are two instances: current day and last day. The first appears as a
        ClassWithMembersAndTypes (0x05), the second as a ClassWithId (0x01)
        back-reference immediately after.
        """
        data = self._load_data()

        expected = [
            'foodByFarms', 'foodByFishers', 'foodByBerrypickers', 'wood',
            'treesCutted', 'treesPlanted', 'stone', 'iron',
            'woodConsuming', 'ironConsuming',
        ]

        cdef = find_class_definition(data, 'ResourcesStatisticContainer', expected)
        if cdef is None:
            self.errors.append("ResourcesStatisticContainer not found")
            return None

        result = {}
        offset = cdef.data_offset
        current = {}
        for name in expected:
            val = struct.unpack_from('<i', data, offset)[0]
            offset += 4
            current[name] = val
        result["currentDay"] = current

        # The second instance (last day) uses ClassWithId (0x01) referencing
        # the object ID of the first instance's class definition.
        if cdef.object_id != 0:
            classid_offset = find_classid_instance(data, cdef.object_id, start=offset)
            if classid_offset is not None:
                last_day = {}
                off2 = classid_offset
                for name in expected:
                    val = struct.unpack_from('<i', data, off2)[0]
                    off2 += 4
                    last_day[name] = val
                result["lastDay"] = last_day

        return result

    def _extract_undead_stats(self) -> Optional[dict]:
        """Extract UndeadResourcesStatisticContainer fields (5 int32s)."""
        data = self._load_data()

        expected = [
            'zombiesByBurial', 'zombiesByCorpses', 'deathMetal', 'spirit', 'bones',
        ]

        cdef = find_class_definition(data, 'UndeadResourcesStatisticContainer', expected)
        if cdef is None:
            # Not an error - undead stats only exist for undead faction saves
            return None

        result = {}
        offset = cdef.data_offset
        current = {}
        for name in expected:
            val = struct.unpack_from('<i', data, offset)[0]
            offset += 4
            current[name] = val
        result["currentDay"] = current

        if cdef.object_id != 0:
            classid_offset = find_classid_instance(data, cdef.object_id, start=offset)
            if classid_offset is not None:
                last_day = {}
                off2 = classid_offset
                for name in expected:
                    val = struct.unpack_from('<i', data, off2)[0]
                    off2 += 4
                    last_day[name] = val
                result["lastDay"] = last_day

        return result

    def _extract_achievements(self) -> Optional[dict]:
        """Extract AchievementsSaveData fields (mixed int32 + bool)."""
        data = self._load_data()

        expected = [
            'gatheredGold', 'lastGold', 'siegeMachineWasTrained',
            'powerUndeadUnitsWasTrained', 'portsDestroyed',
            'marketPartsDestroyed', 'trainedUnitTypes',
        ]
        cdef = find_class_definition(data, 'AchievementsSaveData', expected)
        if cdef is None:
            self.errors.append("AchievementsSaveData not found")
            return None

        offset = cdef.data_offset
        result = {}

        for i, name in enumerate(expected):
            tag = cdef.type_tags[i]
            if tag == TAG_PRIMITIVE:
                prim = cdef.prim_types[i]
                val, offset = read_primitive(data, offset, prim)
                result[name] = val
            else:
                # Stop at non-primitive fields (trainedUnitTypes is a complex array)
                break

        return result

    def _extract_wave_holders(self) -> Optional[dict]:
        """Extract WaveHolderSaveData[] entries.

        The first wave is a ClassWithMembersAndTypes (0x05) record.
        Subsequent waves use ClassWithId (0x01) back-references.
        """
        data = self._load_data()

        expected = ['referenceId', 'waveId', 'mapped', 'fullySpawned', 'waveDestroyed', 'major']
        waves = []

        # Find the first instance (full class definition)
        cdef = find_class_definition(data, 'WaveHolderSaveData', expected)
        if cdef is None:
            return None

        # Read first wave's field values
        wave = self._read_wave_fields(data, cdef.data_offset, cdef)
        if wave is not None:
            waves.append(wave)

        # Find subsequent waves via ClassWithId back-references
        if cdef.object_id != 0:
            for classid_offset in find_all_classid_instances(
                data, cdef.object_id, start=cdef.data_offset
            ):
                wave = self._read_wave_fields(data, classid_offset, cdef)
                if wave is not None:
                    waves.append(wave)

        if not waves:
            return None

        destroyed = sum(1 for w in waves if w.get('waveDestroyed', False))
        major_waves = sum(1 for w in waves if w.get('major', False))

        return {
            "total": len(waves),
            "destroyed": destroyed,
            "majorWaves": major_waves,
            "details": waves,
        }

    @staticmethod
    def _read_wave_fields(data: bytes, offset: int, cdef: ClassDef) -> Optional[dict]:
        """Read WaveHolderSaveData field values from a given offset."""
        wave = {}
        try:
            for i, name in enumerate(cdef.member_names):
                tag = cdef.type_tags[i]
                if tag == TAG_PRIMITIVE:
                    prim = cdef.prim_types[i]
                    val, offset = read_primitive(data, offset, prim)
                    wave[name] = val
                else:
                    break
            else:
                return wave
        except (struct.error, IndexError):
            pass
        return None


# ─── ProfileScanner ───────────────────────────────────────────────────────────

class ProfileScanner:
    """Scans DNOPersistentData directory structure and discovers save files."""

    def __init__(self, data_root: Path):
        self.data_root = data_root

    def get_profiles(self) -> list[str]:
        """Return list of profile directory names."""
        profiles = []
        for entry in sorted(self.data_root.iterdir()):
            if entry.is_dir():
                profiles.append(entry.name)
        return profiles

    def get_active_profile(self) -> Optional[str]:
        """Read the active profile name from the 'profile' file."""
        profile_file = self.data_root / "profile"
        if profile_file.exists():
            return profile_file.read_text(encoding='utf-8-sig').strip()
        return None

    def get_profile_data(self, profile_name: str) -> Optional[dict]:
        """Load profileData.json for a profile."""
        json_path = self.data_root / profile_name / "profileData.json"
        if not json_path.exists():
            return None
        try:
            return json.loads(json_path.read_text())
        except (json.JSONDecodeError, OSError) as e:
            log.warning(f"Failed to read {json_path}: {e}")
            return None

    def find_save_files(self, profile_name: str) -> list[Path]:
        """Find all save files (non-.dat, non-.json files) for a profile."""
        profile_dir = self.data_root / profile_name
        if not profile_dir.exists():
            return []

        saves = []
        # Direct saves in profile dir
        for entry in profile_dir.iterdir():
            if entry.is_file() and not entry.name.endswith(('.dat', '.json')):
                saves.append(entry)
            elif entry.is_dir():
                # UUID subdirectories
                for sub_entry in entry.iterdir():
                    if sub_entry.is_file() and not sub_entry.name.endswith(('.dat', '.json')):
                        saves.append(sub_entry)

        return sorted(saves, key=lambda p: p.name)


# ─── JSONFormatter ────────────────────────────────────────────────────────────

class JSONFormatter:
    """Assembles the final output JSON."""

    @staticmethod
    def format_output(
        profiles: list[dict],
        mission_map: Optional[dict] = None,
    ) -> dict:
        return {
            "extractorVersion": __version__,
            "extractedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "missionMap": mission_map,
            "profiles": profiles,
        }


# ─── Utilities ────────────────────────────────────────────────────────────────

def _format_duration(seconds: float) -> str:
    """Format seconds into H:MM:SS."""
    total = int(seconds)
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    return f"{h}:{m:02d}:{s:02d}"


# Global mission map (populated by --build-mission-map or left empty)
MISSION_MAP: dict[int, str] = {}


def build_mission_map(scanner: ProfileScanner) -> dict[int, str]:
    """Auto-build missionId -> name mapping by reading .dat headers and correlating
    with save file names. Mission start saves have known names like
    'Mission Name, mission start'."""
    mission_map = {}

    for profile_name in scanner.get_profiles():
        save_files = scanner.find_save_files(profile_name)
        for save_path in save_files:
            dat_path = Path(str(save_path) + '.dat')
            if not dat_path.exists():
                continue

            # Only use "mission start" saves for mapping (they have clean mission names)
            name = save_path.name
            if ", mission start" in name:
                mission_name = name.replace(", mission start", "")
            elif ", faction choice" in name:
                mission_name = name.replace(", faction choice", "")
            else:
                continue

            try:
                dat_data = dat_path.read_bytes()
                expected = [
                    'saveVersion', 'missionId', 'difficultyId', 'profileData',
                    'specialHeaderValue', 'customMapName', 'completedCampaignLinks',
                ]
                cdef = find_class_definition(dat_data, 'ProfileSaveHeader', expected)
                if cdef is None:
                    continue
                mission_id = struct.unpack_from('<i', dat_data, cdef.data_offset + 4)[0]
                if mission_id not in mission_map:
                    mission_map[mission_id] = mission_name
                    log.info(f"Mapped mission {mission_id} -> {mission_name}")
            except Exception as e:
                log.debug(f"Failed to read {dat_path}: {e}")

    return mission_map


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Extract statistics from Diplomacy Is Not an Option save files.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --data-root ~/DNOPersistentData --pretty
  %(prog)s --data-root ~/DNOPersistentData --save "AAAAA RATUNKU" --pretty
  %(prog)s --data-root ~/DNOPersistentData --build-mission-map --pretty
        """,
    )
    parser.add_argument(
        "--data-root",
        type=Path,
        default=None,
        help="Path to DNOPersistentData directory (auto-detected if not specified)",
    )
    parser.add_argument("--profile", help="Extract only this profile")
    parser.add_argument("--save", help="Extract only saves matching this name")
    parser.add_argument("--output", type=Path, help="Write JSON to file (default: stdout)")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    parser.add_argument("--build-mission-map", action="store_true", help="Auto-build missionId -> name mapping")
    parser.add_argument("--verbose", action="store_true", help="Enable debug logging to stderr")

    args = parser.parse_args()

    # Setup logging
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s: %(message)s",
        stream=sys.stderr,
    )

    # Auto-detect data root
    data_root = args.data_root
    if data_root is None:
        data_root = _auto_detect_data_root()
        if data_root is None:
            parser.error(
                "Could not auto-detect DNOPersistentData directory. "
                "Please specify --data-root."
            )
    if not data_root.is_dir():
        parser.error(f"Not a directory: {data_root}")

    scanner = ProfileScanner(data_root)

    # Build mission map if requested
    global MISSION_MAP
    if args.build_mission_map:
        MISSION_MAP = build_mission_map(scanner)
        log.info(f"Built mission map with {len(MISSION_MAP)} entries")

    # Determine which profiles to process
    profile_names = scanner.get_profiles()
    if args.profile:
        if args.profile not in profile_names:
            parser.error(f"Profile '{args.profile}' not found. Available: {profile_names}")
        profile_names = [args.profile]

    # Process each profile
    profiles_output = []
    for profile_name in profile_names:
        log.info(f"Processing profile: {profile_name}")

        profile_data = scanner.get_profile_data(profile_name)
        save_files = scanner.find_save_files(profile_name)

        if args.save:
            save_files = [s for s in save_files if args.save in s.name]

        saves_output = []
        for save_path in save_files:
            log.info(f"  Processing save: {save_path.name}")

            file_parser = SaveFileParser(save_path)
            stats = file_parser.extract_all()

            # Split header from statistics
            header = stats.pop("header", None)
            enemies_killed = stats.pop("enemiesKilled", None)
            session_time = stats.pop("sessionTime", None)
            resources = stats.pop("resources", None)
            undead_resources = stats.pop("undeadResources", None)
            achievements = stats.pop("achievements", None)
            waves = stats.pop("waves", None)

            save_entry = {
                "fileName": save_path.name,
                "filePath": str(save_path.relative_to(data_root)),
                "fileSize": save_path.stat().st_size,
                "lastModified": datetime.fromtimestamp(
                    save_path.stat().st_mtime, tz=timezone.utc
                ).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }

            if header is not None:
                save_entry["header"] = header

            statistics = {}
            if enemies_killed is not None:
                statistics["enemiesKilled"] = enemies_killed
            if session_time is not None:
                statistics["sessionTime"] = session_time
            if resources is not None:
                statistics["resources"] = resources
            if undead_resources is not None:
                statistics["undeadResources"] = undead_resources
            if achievements is not None:
                statistics["achievements"] = achievements
            if waves is not None:
                statistics["waves"] = waves

            save_entry["statistics"] = statistics

            if file_parser.errors:
                save_entry["errors"] = file_parser.errors

            saves_output.append(save_entry)

        profile_entry = {
            "name": profile_name,
            "isActive": profile_name == scanner.get_active_profile(),
        }
        if profile_data is not None:
            # Extract the interesting parts of profileData.json
            profile_entry["profileData"] = {
                "version": profile_data.get("version"),
                "completedMissionsData": profile_data.get("completedMissionsData", []),
                "campaignProfiles": profile_data.get("campaignProfiles", []),
            }
        profile_entry["saves"] = saves_output
        profiles_output.append(profile_entry)

    # Assemble final output
    output = JSONFormatter.format_output(
        profiles=profiles_output,
        mission_map=MISSION_MAP if MISSION_MAP else None,
    )

    # Write output
    json_kwargs = {"indent": 2} if args.pretty else {"separators": (",", ":")}
    json_str = json.dumps(output, **json_kwargs, ensure_ascii=False)

    if args.output:
        args.output.write_text(json_str + "\n")
        log.info(f"Output written to {args.output}")
    else:
        print(json_str)


def _auto_detect_data_root() -> Optional[Path]:
    """Try to auto-detect the DNOPersistentData directory."""
    candidates = [
        # Linux (Steam Proton)
        Path.home() / ".local/share/Steam/steamapps/compatdata/1272320/pfx/drive_c/users/steamuser/AppData/LocalLow/Door 407/Diplomacy is Not an Option/DNOPersistentData",
        # Linux (native, unlikely but check)
        Path.home() / ".config/unity3d/Door 407/Diplomacy is Not an Option/DNOPersistentData",
        # Windows
        Path.home() / "AppData/LocalLow/Door 407/Diplomacy is Not an Option/DNOPersistentData",
        # Common dev location
        Path.home() / "repos/Diplomacy is Not an Option/DNOPersistentData",
    ]
    for candidate in candidates:
        if candidate.is_dir():
            log.info(f"Auto-detected data root: {candidate}")
            return candidate
    return None


if __name__ == "__main__":
    main()

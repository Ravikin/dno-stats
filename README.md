# DNO Stats

Save file statistics viewer for **Diplomacy Is Not an Option**.

View interactive charts and reports for your save files — entirely client-side, no data ever leaves your browser.

**Live site: https://ravikin.github.io/dno-stats/**

## How to use

### Option 1: Upload a raw save file (easiest)

1. Find your save files:
   - **Windows:** `%APPDATA%\..\LocalLow\Door 407\Diplomacy is Not an Option\DNOPersistentData\<YourProfile>\`
   - **Linux (Steam/Proton):** `~/.local/share/Steam/steamapps/compatdata/1272320/pfx/drive_c/users/steamuser/AppData/LocalLow/Door 407/Diplomacy is Not an Option/DNOPersistentData/<YourProfile>/`
2. Select a save file and its `.dat` companion (e.g. `ritual boss` + `ritual boss.dat`)
3. Drop both files onto the upload zone

### Option 2: Upload stats.json (full report with all saves)

1. Run the Python extractor to generate `stats.json`:
   ```bash
   python3 dno_stats.py --build-mission-map --pretty --output stats.json
   ```
   It auto-detects your save directory, or you can specify it:
   ```bash
   python3 dno_stats.py --data-root ~/path/to/DNOPersistentData --build-mission-map --pretty --output stats.json
   ```
2. Drop `stats.json` onto the upload zone

## Python extractor options

```
python3 dno_stats.py [OPTIONS]

--data-root PATH    Path to DNOPersistentData (auto-detected if omitted)
--profile NAME      Extract only this profile
--save NAME         Extract only saves matching this name
--build-mission-map Auto-build mission ID to name mapping
--output FILE       Write JSON to file (default: stdout)
--pretty            Pretty-print JSON
--verbose           Debug logging to stderr
```

## What gets extracted

- Enemies killed
- Session time (game time and real time)
- Resource production (farms, fishers, berries, wood, stone, iron)
- Undead resources (zombies, death metal, spirit, bones) when applicable
- Achievements (gold gathered, siege machines, ports/markets destroyed)
- Wave data (total, destroyed, major waves)
- Mission header (mission name, difficulty, save version)

## Project structure

```
index.html       Web app shell with upload UI
style.css        Dark theme styling
app.js           Upload handling + chart/report rendering
save-parser.js   Browser-side binary parser (.NET BinaryFormatter)
dno_stats.py     Python CLI extractor (generates stats.json)
```

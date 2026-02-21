// ─── DNO Stats Web App ───────────────────────────────────────────────────────

const chartInstances = [];

// ─── Upload Handling ─────────────────────────────────────────────────────────

function initUpload() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const browseBtn = document.getElementById('browse-btn');
  const sampleBtn = document.getElementById('sample-btn');

  browseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFiles(Array.from(fileInput.files));
  });

  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleFiles(Array.from(e.dataTransfer.files));
  });

  sampleBtn.addEventListener('click', loadSampleData);
}

function handleFiles(files) {
  hideError();
  console.log('[upload] Received files:', files.map(f => `${f.name} (${(f.size / 1024).toFixed(1)} KB)`));

  // Single JSON file -> existing JSON flow
  if (files.length === 1 && files[0].name.endsWith('.json')) {
    console.log('[upload] Routing to JSON handler');
    handleJsonFile(files[0]);
    return;
  }

  // Two files -> save file + .dat pair
  if (files.length === 2) {
    const datFile = files.find(f => f.name.endsWith('.dat'));
    const saveFile = files.find(f => !f.name.endsWith('.dat') && !f.name.endsWith('.json'));
    if (datFile && saveFile) {
      console.log('[upload] Routing to save file handler:', saveFile.name, '+', datFile.name);
      handleSaveFiles(saveFile, datFile);
      return;
    }
    console.warn('[upload] Two files but no valid save+dat pair. datFile:', datFile?.name, 'saveFile:', saveFile?.name);
  }

  // Single non-JSON file without .dat companion
  if (files.length === 1 && !files[0].name.endsWith('.json')) {
    showError(
      'Missing companion file',
      'Raw save files need their .dat companion. Please drop both the save file and its .dat file together.'
    );
    return;
  }

  showError(
    'Unrecognized files',
    'Please upload a stats.json file, or drop a save file together with its .dat companion.'
  );
}

function handleJsonFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const stats = JSON.parse(reader.result);
      const error = validateStats(stats);
      if (error) {
        showError('Invalid stats file', error);
        return;
      }
      showReport(stats);
    } catch (e) {
      showError('JSON parse error', 'The file is not valid JSON. Make sure you exported it with dno_stats.py.');
    }
  };
  reader.onerror = () => showError('File read error', 'Could not read the file.');
  reader.readAsText(file);
}

async function handleSaveFiles(saveFile, datFile) {
  const dropTitle = document.querySelector('#drop-zone .drop-title');
  const originalText = dropTitle.textContent;
  dropTitle.textContent = 'Parsing save file...';

  try {
    const stats = await parseSaveFiles(saveFile, datFile);
    const error = validateStats(stats);
    if (error) {
      showError('Parse error', error);
      dropTitle.textContent = originalText;
      return;
    }
    showReport(stats);
  } catch (e) {
    showError('Save file parse error', `Could not parse the save file: ${e.message}`);
    dropTitle.textContent = originalText;
  }
}

function validateStats(stats) {
  if (!stats || typeof stats !== 'object') return 'File does not contain a JSON object.';
  if (!stats.extractorVersion) return 'Missing extractorVersion. This does not look like a dno_stats.py export.';
  if (!Array.isArray(stats.profiles) || stats.profiles.length === 0) return 'No profiles found in the stats file.';
  if (!stats.profiles[0].saves || !Array.isArray(stats.profiles[0].saves)) return 'No save data found in the first profile.';
  return null;
}

function loadSampleData() {
  hideError();
  const sample = buildSampleData();
  showReport(sample);
}

function buildSampleData() {
  return {
    extractorVersion: 'sample',
    extractedAt: new Date().toISOString(),
    missionMap: { '-1': "Let's learn", '0': 'Wake-up call' },
    profiles: [{
      name: 'Sample Player',
      isActive: true,
      profileData: { completedMissionsData: [{ id: -1, difficultyIndexes: [0] }], campaignProfiles: [{ completedLinks: [] }] },
      saves: [
        {
          fileName: 'Tutorial Save',
          filePath: 'Sample/tutorial',
          fileSize: 1500000,
          lastModified: new Date().toISOString(),
          header: { saveVersion: 14, missionId: -1, missionIdName: "Let's learn", difficultyId: 0, difficultyName: 'Easy-Peasy Lemon Squeezy' },
          statistics: {
            enemiesKilled: 42,
            sessionTime: { gameSeconds: 900, realSeconds: 1020, gameFormatted: '0:15:00', realFormatted: '0:17:00' },
            resources: {
              currentDay: { foodByFarms: 20, foodByFishers: 15, foodByBerrypickers: 10, wood: 80, treesCutted: 12, treesPlanted: 0, stone: 30, iron: 5, woodConsuming: 0, ironConsuming: 0 },
              lastDay: { foodByFarms: 35, foodByFishers: 25, foodByBerrypickers: 18, wood: 120, treesCutted: 20, treesPlanted: 0, stone: 50, iron: 10, woodConsuming: 5, ironConsuming: 0 },
            },
            achievements: { gatheredGold: 15, lastGold: 8, siegeMachineWasTrained: false, powerUndeadUnitsWasTrained: false, portsDestroyed: 0, marketPartsDestroyed: 0 },
          },
        },
        {
          fileName: 'Wake-up call progress',
          filePath: 'Sample/wakeup',
          fileSize: 2200000,
          lastModified: new Date().toISOString(),
          header: { saveVersion: 14, missionId: 0, missionIdName: 'Wake-up call', difficultyId: 1, difficultyName: 'Almost a Walk in the Park' },
          statistics: {
            enemiesKilled: 310,
            sessionTime: { gameSeconds: 2400, realSeconds: 2700, gameFormatted: '0:40:00', realFormatted: '0:45:00' },
            resources: {
              currentDay: { foodByFarms: 50, foodByFishers: 30, foodByBerrypickers: 25, wood: 200, treesCutted: 30, treesPlanted: 0, stone: 100, iron: 20, woodConsuming: 10, ironConsuming: 0 },
              lastDay: { foodByFarms: 80, foodByFishers: 45, foodByBerrypickers: 40, wood: 350, treesCutted: 45, treesPlanted: 0, stone: 180, iron: 35, woodConsuming: 20, ironConsuming: 0 },
            },
            achievements: { gatheredGold: 45, lastGold: 20, siegeMachineWasTrained: false, powerUndeadUnitsWasTrained: false, portsDestroyed: 0, marketPartsDestroyed: 0 },
            waves: { total: 2, destroyed: 1, majorWaves: 1, details: [] },
          },
        },
      ],
    }],
  };
}

// ─── UI Helpers ──────────────────────────────────────────────────────────────

function showError(title, message) {
  const section = document.getElementById('error-section');
  section.querySelector('.error-title').textContent = title;
  section.querySelector('.error-message').textContent = message;
  section.style.display = 'block';
}

function hideError() {
  document.getElementById('error-section').style.display = 'none';
}

function showReport(stats) {
  document.getElementById('upload-section').style.display = 'none';
  hideError();
  const reportSection = document.getElementById('report-section');
  reportSection.classList.add('visible');
  renderReport(stats);
}

function resetToUpload() {
  destroyAllCharts();
  document.getElementById('report-section').classList.remove('visible');
  document.getElementById('report-content').innerHTML = '';
  document.getElementById('upload-section').style.display = 'flex';
  document.getElementById('file-input').value = '';
}

function destroyAllCharts() {
  chartInstances.forEach(c => c.destroy());
  chartInstances.length = 0;
}

function trackChart(chart) {
  chartInstances.push(chart);
  return chart;
}

// ─── Report Rendering ────────────────────────────────────────────────────────

function renderReport(stats) {
  destroyAllCharts();

  const profile = stats.profiles[0];
  const allSaves = profile.saves;
  const diffNames = {
    0: 'Easy-Peasy Lemon Squeezy',
    1: 'Almost a Walk in the Park',
    2: 'Challenge Accepted',
    3: 'Ultra-Hardcore',
    4: 'Pure Insanity',
    5: 'Your Worst Nightmare',
  };
  const palette = ['#c9873b', '#3bc977', '#3b8ec9', '#e84393', '#9b59b6', '#1abc9c', '#e67e22', '#c94040'];
  const resourceFields = [
    { key: 'foodByFarms', label: 'Farms', color: '#27ae60' },
    { key: 'foodByFishers', label: 'Fishers', color: '#3498db' },
    { key: 'foodByBerrypickers', label: 'Berries', color: '#e84393' },
    { key: 'wood', label: 'Wood', color: '#c9873b' },
    { key: 'stone', label: 'Stone', color: '#95a5a6' },
    { key: 'iron', label: 'Iron', color: '#7f8c8d' },
  ];

  Chart.defaults.color = '#8b949e';
  Chart.defaults.borderColor = '#30363d';
  Chart.defaults.font.family = "'Segoe UI', -apple-system, sans-serif";

  function fmtDuration(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }
  function fmtNum(n) { return n.toLocaleString(); }

  // ─── Group saves by mission ──────────────────────────────────────────
  const missionGroups = new Map();
  allSaves.forEach(s => {
    const name = s.header?.missionIdName || 'Unknown';
    if (!missionGroups.has(name)) {
      missionGroups.set(name, {
        name,
        difficulty: s.header?.difficultyName || '?',
        difficultyId: s.header?.difficultyId ?? -1,
        missionId: s.header?.missionId,
        saves: [],
      });
    }
    missionGroups.get(name).saves.push(s);
  });

  const missions = [...missionGroups.values()].map(g => {
    g.saves.sort((a, b) =>
      (b.statistics?.sessionTime?.gameSeconds || 0) - (a.statistics?.sessionTime?.gameSeconds || 0)
    );
    const best = g.saves[0];
    return {
      ...g,
      best,
      maxEnemies: Math.max(...g.saves.map(s => s.statistics?.enemiesKilled || 0)),
      maxGameTime: Math.max(...g.saves.map(s => s.statistics?.sessionTime?.gameSeconds || 0)),
      maxRealTime: Math.max(...g.saves.map(s => s.statistics?.sessionTime?.realSeconds || 0)),
      totalGold: Math.max(...g.saves.map(s => s.statistics?.achievements?.gatheredGold || 0)),
      hasGameplay: g.saves.some(s => (s.statistics?.sessionTime?.gameSeconds || 0) > 10),
      totalWaves: Math.max(...g.saves.map(s => s.statistics?.waves?.total || 0)),
    };
  });

  missions.sort((a, b) => {
    if (a.hasGameplay !== b.hasGameplay) return b.hasGameplay - a.hasGameplay;
    return b.maxGameTime - a.maxGameTime;
  });

  const playedMissions = missions.filter(m => m.hasGameplay);

  // Global aggregates
  const totalEnemies = allSaves.reduce((sum, s) => sum + (s.statistics?.enemiesKilled || 0), 0);
  const totalGameTime = allSaves.reduce((sum, s) => sum + (s.statistics?.sessionTime?.gameSeconds || 0), 0);
  const totalRealTime = allSaves.reduce((sum, s) => sum + (s.statistics?.sessionTime?.realSeconds || 0), 0);
  const totalGold = allSaves.reduce((sum, s) => sum + (s.statistics?.achievements?.gatheredGold || 0), 0);

  // ─── Build HTML ──────────────────────────────────────────────────────
  const app = document.getElementById('report-content');

  let html = `
    <div class="reset-bar"><button class="reset-btn" id="reset-btn">Load different file</button></div>
    <div class="summary-grid">
      <div class="summary-card"><div class="value">${missions.length}</div><div class="label">Missions</div></div>
      <div class="summary-card"><div class="value">${allSaves.length}</div><div class="label">Total Saves</div></div>
      <div class="summary-card"><div class="value">${fmtNum(totalEnemies)}</div><div class="label">Total Enemies Killed</div></div>
      <div class="summary-card"><div class="value">${fmtDuration(totalGameTime)}</div><div class="label">Total Game Time</div></div>
      <div class="summary-card"><div class="value">${fmtDuration(totalRealTime)}</div><div class="label">Total Real Time</div></div>
      <div class="summary-card"><div class="value">${fmtNum(totalGold)}</div><div class="label">Total Gold</div></div>
    </div>

    <div class="section-title">Missions Overview</div>
    <div class="chart-grid">
      <div class="chart-box"><h3>Enemies Killed (best save per mission)</h3><canvas id="chartMissionEnemies"></canvas></div>
      <div class="chart-box"><h3>Game Time (best save per mission)</h3><canvas id="chartMissionTime"></canvas></div>
    </div>
    <div class="chart-grid">
      <div class="chart-box"><h3>Resource Production by Mission (last day, best save)</h3><canvas id="chartMissionResources"></canvas></div>
      <div class="chart-box"><h3>Gold Gathered by Mission</h3><canvas id="chartMissionGold"></canvas></div>
    </div>

    <div class="section-title">Campaign Progress</div>
    <div class="chart-box" style="margin-bottom:1.5rem">
      <table class="mission-table">
        <thead><tr><th>Mission</th><th>Difficulty</th><th>Saves</th><th>Best Enemies</th><th>Best Game Time</th><th>Status</th></tr></thead>
        <tbody id="missionTableBody"></tbody>
      </table>
    </div>
  `;

  // ─── Per-mission sections ──────────────────────────────────────────
  missions.forEach((m, mi) => {
    const diffClass = m.difficultyId >= 0 ? `diff-${m.difficultyId}` : '';
    const diffBadge = m.difficulty ? `<span class="difficulty-badge ${diffClass}">${m.difficulty}</span>` : '';
    const slug = `mission_${mi}`;
    const gameplaySaves = m.saves.filter(s => (s.statistics?.sessionTime?.gameSeconds || 0) > 10);
    const hasMultipleSaves = gameplaySaves.length > 1;
    const hasResources = m.saves.some(s => {
      const ld = s.statistics?.resources?.lastDay;
      return ld && Object.values(ld).some(v => v > 0);
    });

    html += `<div class="section-title">${m.name} ${diffBadge}</div>`;

    html += `<div class="summary-grid" style="margin-bottom:1rem">
      <div class="summary-card"><div class="value">${m.saves.length}</div><div class="label">Saves</div></div>
      <div class="summary-card"><div class="value">${fmtNum(m.maxEnemies)}</div><div class="label">Best Enemies</div></div>
      <div class="summary-card"><div class="value">${fmtDuration(m.maxGameTime)}</div><div class="label">Best Game Time</div></div>
      <div class="summary-card"><div class="value">${fmtNum(m.totalGold)}</div><div class="label">Best Gold</div></div>
      ${m.totalWaves > 0 ? `<div class="summary-card"><div class="value">${m.totalWaves}</div><div class="label">Waves</div></div>` : ''}
    </div>`;

    if (hasMultipleSaves) {
      html += `<div class="chart-grid">
        <div class="chart-box"><h3>Save Progression: Enemies & Time</h3><canvas id="${slug}_progression"></canvas></div>`;
      if (hasResources) {
        html += `<div class="chart-box"><h3>Resource Production Across Saves</h3><canvas id="${slug}_resources"></canvas></div>`;
      }
      html += `</div>`;
    } else if (hasResources && gameplaySaves.length === 1) {
      html += `<div class="chart-grid">
        <div class="chart-box"><h3>Current Day vs Last Day Resources</h3><canvas id="${slug}_daycompare"></canvas></div>
        <div class="chart-box"><h3>Food Source Breakdown (Last Day)</h3><canvas id="${slug}_food"></canvas></div>
      </div>`;
    }

    html += `<div class="save-cards">`;
    m.saves.forEach(s => {
      const st = s.statistics || {};
      const lastRes = st.resources?.lastDay || {};
      const totalFood = (lastRes.foodByFarms || 0) + (lastRes.foodByFishers || 0) + (lastRes.foodByBerrypickers || 0);
      const waves = st.waves;
      const modDate = new Date(s.lastModified).toLocaleString();
      const fileMB = (s.fileSize / (1024 * 1024)).toFixed(1);
      html += `<div class="save-card">
        <div class="save-name">${s.fileName}</div>
        <div class="save-meta">${modDate} &mdash; ${fileMB} MB</div>
        <div class="stat-grid">
          <div class="stat-row"><span class="stat-label">Enemies Killed</span><span class="stat-value">${fmtNum(st.enemiesKilled ?? 0)}</span></div>
          <div class="stat-row"><span class="stat-label">Gold</span><span class="stat-value">${st.achievements?.gatheredGold ?? 0}</span></div>
          <div class="stat-row"><span class="stat-label">Game Time</span><span class="stat-value">${st.sessionTime?.gameFormatted || '-'}</span></div>
          <div class="stat-row"><span class="stat-label">Real Time</span><span class="stat-value">${st.sessionTime?.realFormatted || '-'}</span></div>
          <div class="stat-row"><span class="stat-label">Food (last day)</span><span class="stat-value">${totalFood}</span></div>
          <div class="stat-row"><span class="stat-label">Wood (last day)</span><span class="stat-value">${lastRes.wood || 0}</span></div>
          <div class="stat-row"><span class="stat-label">Stone (last day)</span><span class="stat-value">${lastRes.stone || 0}</span></div>
          <div class="stat-row"><span class="stat-label">Iron (last day)</span><span class="stat-value">${lastRes.iron || 0}</span></div>
          ${waves ? `<div class="stat-row"><span class="stat-label">Waves</span><span class="stat-value">${waves.total} (${waves.destroyed} dest.)</span></div>
          <div class="stat-row"><span class="stat-label">Major Waves</span><span class="stat-value">${waves.majorWaves}</span></div>` : ''}
        </div>
      </div>`;
    });
    html += `</div>`;
  });

  const generatorLabel = stats.extractorVersion === 'browser-1.0'
    ? 'Parsed in browser'
    : `Generated by dno_stats.py v${stats.extractorVersion}`;
  html += `<div class="footer">${generatorLabel} &mdash; ${stats.extractedAt} &mdash; Profile: ${profile.name}</div>`;

  app.innerHTML = html;

  // ─── Reset button ────────────────────────────────────────────────────
  document.getElementById('reset-btn').addEventListener('click', resetToUpload);

  // ─── Charts: Mission Overview ────────────────────────────────────────
  trackChart(new Chart(document.getElementById('chartMissionEnemies'), {
    type: 'bar',
    data: {
      labels: playedMissions.map(m => m.name),
      datasets: [{
        label: 'Enemies Killed',
        data: playedMissions.map(m => m.maxEnemies),
        backgroundColor: playedMissions.map((_, i) => palette[i % palette.length]),
        borderRadius: 4, borderSkipped: false,
      }]
    },
    options: {
      indexAxis: 'y', responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { afterLabel: ctx => `Difficulty: ${playedMissions[ctx.dataIndex].difficulty}` } }
      },
      scales: { x: { grid: { color: '#1c2333' } }, y: { grid: { display: false } } }
    }
  }));

  trackChart(new Chart(document.getElementById('chartMissionTime'), {
    type: 'bar',
    data: {
      labels: playedMissions.map(m => m.name),
      datasets: [
        { label: 'Game Time (min)', data: playedMissions.map(m => (m.maxGameTime / 60).toFixed(1)), backgroundColor: '#c9873b', borderRadius: 4, borderSkipped: false },
        { label: 'Real Time (min)', data: playedMissions.map(m => (m.maxRealTime / 60).toFixed(1)), backgroundColor: '#3b8ec9', borderRadius: 4, borderSkipped: false },
      ]
    },
    options: {
      indexAxis: 'y', responsive: true,
      plugins: { legend: { position: 'top' } },
      scales: { x: { title: { display: true, text: 'Minutes' }, grid: { color: '#1c2333' } }, y: { grid: { display: false } } }
    }
  }));

  const resMissions = playedMissions.filter(m => {
    const ld = m.best.statistics?.resources?.lastDay;
    return ld && Object.values(ld).some(v => v > 0);
  });
  trackChart(new Chart(document.getElementById('chartMissionResources'), {
    type: 'bar',
    data: {
      labels: resMissions.map(m => m.name),
      datasets: resourceFields.map(f => ({
        label: f.label,
        data: resMissions.map(m => m.best.statistics?.resources?.lastDay?.[f.key] || 0),
        backgroundColor: f.color, borderRadius: 2, borderSkipped: false,
      }))
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'top' } },
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, grid: { color: '#1c2333' } } }
    }
  }));

  const goldMissions = playedMissions.filter(m => m.totalGold > 0);
  trackChart(new Chart(document.getElementById('chartMissionGold'), {
    type: 'bar',
    data: {
      labels: goldMissions.map(m => m.name),
      datasets: [
        { label: 'Gold Gathered', data: goldMissions.map(m => m.totalGold), backgroundColor: '#e0924a', borderRadius: 4, borderSkipped: false },
        { label: 'Last Gold', data: goldMissions.map(m => Math.max(...m.saves.map(s => s.statistics?.achievements?.lastGold || 0))), backgroundColor: '#9b59b6', borderRadius: 4, borderSkipped: false },
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'top' } },
      scales: { x: { grid: { display: false } }, y: { grid: { color: '#1c2333' } } }
    }
  }));

  // ─── Campaign Progress Table ───────────────────────────────────────
  const tbody = document.getElementById('missionTableBody');
  const completedMissions = profile.profileData?.completedMissionsData || [];

  missions.forEach(m => {
    const completed = completedMissions.find(c => c.id === m.missionId);
    const diffs = completed
      ? (completed.difficultyIndexes || []).map(d => {
          const dn = diffNames[d] || `?${d}`;
          return `<span class="difficulty-badge diff-${d}">${dn}</span>`;
        }).join(' ')
      : `<span class="difficulty-badge diff-${m.difficultyId}">${m.difficulty}</span>`;
    const status = completed
      ? '<span style="color: #3bc977">Completed</span>'
      : (m.hasGameplay ? '<span style="color: #fbbf24">In Progress</span>' : '<span style="color: var(--text-dim)">Started</span>');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${m.name}</td><td>${diffs}</td><td>${m.saves.length}</td><td>${fmtNum(m.maxEnemies)}</td><td>${fmtDuration(m.maxGameTime)}</td><td>${status}</td>`;
    tbody.appendChild(tr);
  });

  // ─── Per-mission charts ────────────────────────────────────────────
  missions.forEach((m, mi) => {
    const slug = `mission_${mi}`;
    const gameplaySaves = m.saves.filter(s => (s.statistics?.sessionTime?.gameSeconds || 0) > 10);
    const hasResources = m.saves.some(s => {
      const ld = s.statistics?.resources?.lastDay;
      return ld && Object.values(ld).some(v => v > 0);
    });

    if (gameplaySaves.length > 1) {
      const sorted = [...gameplaySaves].sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified));
      const el = document.getElementById(`${slug}_progression`);
      if (el) {
        trackChart(new Chart(el, {
          type: 'bar',
          data: {
            labels: sorted.map(s => s.fileName),
            datasets: [
              { label: 'Enemies Killed', data: sorted.map(s => s.statistics?.enemiesKilled || 0), backgroundColor: '#c94040', borderRadius: 4, borderSkipped: false, yAxisID: 'y' },
              { label: 'Game Time (min)', data: sorted.map(s => ((s.statistics?.sessionTime?.gameSeconds || 0) / 60).toFixed(1)), backgroundColor: '#3b8ec9', borderRadius: 4, borderSkipped: false, yAxisID: 'y1' },
            ]
          },
          options: {
            responsive: true,
            plugins: { legend: { position: 'top' } },
            scales: {
              x: { grid: { display: false } },
              y: { position: 'left', grid: { color: '#1c2333' }, title: { display: true, text: 'Enemies' } },
              y1: { position: 'right', grid: { display: false }, title: { display: true, text: 'Minutes' } },
            }
          }
        }));
      }

      const resEl = document.getElementById(`${slug}_resources`);
      if (resEl && hasResources) {
        const resSaves = sorted.filter(s => {
          const ld = s.statistics?.resources?.lastDay;
          return ld && Object.values(ld).some(v => v > 0);
        });
        trackChart(new Chart(resEl, {
          type: 'bar',
          data: {
            labels: resSaves.map(s => s.fileName),
            datasets: resourceFields.map(f => ({
              label: f.label,
              data: resSaves.map(s => s.statistics?.resources?.lastDay?.[f.key] || 0),
              backgroundColor: f.color, borderRadius: 2, borderSkipped: false,
            }))
          },
          options: {
            responsive: true,
            plugins: { legend: { position: 'top' } },
            scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, grid: { color: '#1c2333' } } }
          }
        }));
      }
    } else if (hasResources && gameplaySaves.length === 1) {
      const s = gameplaySaves[0];
      const cur = s.statistics?.resources?.currentDay || {};
      const last = s.statistics?.resources?.lastDay || {};

      const radarEl = document.getElementById(`${slug}_daycompare`);
      if (radarEl) {
        const labels = ['Farms', 'Fishers', 'Berries', 'Wood', 'Stone', 'Iron'];
        const keys = ['foodByFarms', 'foodByFishers', 'foodByBerrypickers', 'wood', 'stone', 'iron'];
        trackChart(new Chart(radarEl, {
          type: 'radar',
          data: {
            labels,
            datasets: [
              { label: 'Current Day', data: keys.map(k => cur[k] || 0), borderColor: '#c9873b', backgroundColor: 'rgba(201,135,59,0.15)', pointBackgroundColor: '#c9873b' },
              { label: 'Last Day', data: keys.map(k => last[k] || 0), borderColor: '#3bc977', backgroundColor: 'rgba(59,201,119,0.15)', pointBackgroundColor: '#3bc977' },
            ]
          },
          options: {
            responsive: true,
            scales: { r: { grid: { color: '#30363d' }, angleLines: { color: '#30363d' }, pointLabels: { color: '#8b949e' }, ticks: { display: false } } }
          }
        }));
      }

      const foodEl = document.getElementById(`${slug}_food`);
      if (foodEl) {
        const foodData = [
          { label: 'Farms', value: last.foodByFarms || 0, color: '#27ae60' },
          { label: 'Fishers', value: last.foodByFishers || 0, color: '#3498db' },
          { label: 'Berrypickers', value: last.foodByBerrypickers || 0, color: '#e84393' },
        ];
        trackChart(new Chart(foodEl, {
          type: 'doughnut',
          data: { labels: foodData.map(d => d.label), datasets: [{ data: foodData.map(d => d.value), backgroundColor: foodData.map(d => d.color), borderWidth: 0 }] },
          options: { responsive: true, plugins: { legend: { position: 'right' } } }
        }));
      }
    }
  });
}

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', initUpload);

function extractWatchID(link) {
  if (!link) return '';
  const m = link.match(/[?&]v=([^&#]+)/);
  return m ? m[1] : '';
}

function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = type;
}

function setProgress(pct) {
  const bar  = document.getElementById('progress-bar');
  const fill = document.getElementById('progress-fill');
  if (pct === 0) {
    bar.classList.remove('show');
  } else {
    bar.classList.add('show');
    fill.style.width = pct + '%';
  }
}

function normalizeBackupVideo(v) {
  return {
    videolink:   v.videolink   || '',
    title:       v.title       || '',
    channel:     v.channel     || '',
    time:        v.time        !== undefined ? v.time        : (v.resumeSeconds   || 0),
    duration:    v.duration    !== undefined ? v.duration    : (v.durationSeconds || 0),
    complete:    v.complete    || false,
    doNotResume: v.doNotResume || false,
    timestamp:   v.timestamp   || 0,
    watchCount:  v.watchCount  !== undefined ? v.watchCount  : (v.timesWatched    || 1)
  };
}

function processFile(file) {
  if (!file) return;
  if (!file.name.endsWith('.json')) {
    setStatus('Please select a .json backup file.', 'error');
    return;
  }

  setStatus('Reading file…', 'info');
  setProgress(20);

  const reader = new FileReader();

  reader.onerror = () => {
    setStatus('Failed to read file.', 'error');
    setProgress(0);
  };

  reader.onload = (ev) => {
    try {
      const backup = JSON.parse(ev.target.result);
      if (!Array.isArray(backup.ytProVideos)) {
        throw new Error('Invalid backup file — missing ytProVideos array.');
      }

      setProgress(50);
      setStatus('Merging with existing history…', 'info');

      chrome.storage.local.get(['ytProVideos', 'resumeSettings'], (existing) => {
        if (chrome.runtime.lastError) {
          setStatus('Storage error: ' + chrome.runtime.lastError.message, 'error');
          setProgress(0);
          return;
        }

        const existingVideos = existing.ytProVideos || [];
        const backupVideos   = backup.ytProVideos.map(normalizeBackupVideo);

        const merged = {};
        existingVideos.forEach(v => {
          const id = extractWatchID(v.videolink);
          if (id) merged[id] = v;
        });

        let newCount = 0;
        backupVideos.forEach(v => {
          const id = extractWatchID(v.videolink);
          if (!id) return;
          if (!merged[id]) {
            newCount++;
            merged[id] = v;
          } else {
            merged[id] = {
              ...merged[id],
              ...v,
              watchCount: Math.max(v.watchCount || 0, merged[id].watchCount || 0),
              timestamp:  Math.max(v.timestamp  || 0, merged[id].timestamp  || 0)
            };
          }
        });

        // Sort oldest-first so loadResumeHistory's .reverse() shows newest at the top
        const finalVideos = Object.values(merged).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        const toSave = { ytProVideos: finalVideos };
        if (backup.resumeSettings && Object.keys(backup.resumeSettings).length) {
          toSave.resumeSettings = backup.resumeSettings;
        }

        setProgress(80);

        chrome.storage.local.set(toSave, () => {
          if (chrome.runtime.lastError) {
            setStatus('Failed to save: ' + chrome.runtime.lastError.message, 'error');
            setProgress(0);
            return;
          }

          setProgress(100);
          setStatus('Restored! ' + finalVideos.length + ' total videos (' + newCount + ' new added).', 'success');

          chrome.runtime.sendMessage({ action: 'restoreComplete' }, () => {
            void chrome.runtime.lastError; // suppress unchecked error if popup is closed
          });

          document.getElementById('close-hint').classList.add('show');
          setTimeout(() => window.close(), 3000);
        });
      });

    } catch (err) {
      setStatus('' + (err.message || 'Invalid backup file!'), 'error');
      setProgress(0);
    }
  };

  reader.readAsText(file);
}

document.addEventListener('DOMContentLoaded', () => {
  // File input change
  document.getElementById('file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    processFile(file);
  });

  // Drag and drop on the drop zone
  const dz = document.getElementById('drop-zone');
  dz.addEventListener('dragover',  (e) => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', ()  => dz.classList.remove('drag-over'));
  dz.addEventListener('drop',      (e) => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    processFile(e.dataTransfer.files[0]);
  });
});

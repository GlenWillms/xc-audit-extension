const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', loadAll);

async function loadAll() {
  const { baseline, explanations, settings } =
    await chrome.storage.local.get(['baseline', 'explanations', 'settings']);

  if (baseline) {
    $('baselineEditor').value = JSON.stringify(baseline, null, 2);
  }
  if (explanations) {
    $('explanationsEditor').value = JSON.stringify(explanations, null, 2);
  }

  const s = settings || {};
  $('autoAudit').checked = s.autoAudit !== false;
  $('cacheTtl').value = s.cacheTtlSeconds || 300;

  bindEvents();
}

function bindEvents() {
  $('saveBaseline').addEventListener('click', async () => {
    if (await saveJson('baselineEditor', 'baseline', 'baselineError')) {
      showStatus('baselineStatus', 'Baseline saved', 'success');
    }
  });

  $('saveExplanations').addEventListener('click', async () => {
    if (await saveJson('explanationsEditor', 'explanations', 'explanationsError')) {
      showStatus('explanationsStatus', 'Explanations saved', 'success');
    }
  });

  $('resetBaseline').addEventListener('click', async () => {
    const resp = await fetch(chrome.runtime.getURL('assets/baseline_lb_http.json'));
    const data = await resp.json();
    $('baselineEditor').value = JSON.stringify(data, null, 2);
    await chrome.storage.local.set({ baseline: data });
    $('baselineError').textContent = '';
    showStatus('baselineStatus', 'Reset to default', 'success');
  });

  $('resetExplanations').addEventListener('click', async () => {
    const resp = await fetch(chrome.runtime.getURL('assets/explanations.json'));
    const data = await resp.json();
    $('explanationsEditor').value = JSON.stringify(data, null, 2);
    await chrome.storage.local.set({ explanations: data });
    $('explanationsError').textContent = '';
    showStatus('explanationsStatus', 'Reset to default', 'success');
  });

  $('uploadBaseline').addEventListener('change', (e) => handleUpload(e, 'baselineEditor', 'baselineError'));
  $('uploadExplanations').addEventListener('change', (e) => handleUpload(e, 'explanationsEditor', 'explanationsError'));

  $('saveSettings').addEventListener('click', async () => {
    await chrome.storage.local.set({
      settings: {
        autoAudit: $('autoAudit').checked,
        cacheTtlSeconds: parseInt($('cacheTtl').value, 10) || 300,
      },
    });
    showStatus('settingsStatus', 'Settings saved', 'success');
  });
}

async function saveJson(editorId, storageKey, errorId) {
  const text = $(editorId).value;
  try {
    const data = JSON.parse(text);
    await chrome.storage.local.set({ [storageKey]: data });
    $(errorId).textContent = '';
    return true;
  } catch (e) {
    $(errorId).textContent = `Invalid JSON: ${e.message}`;
    return false;
  }
}

function handleUpload(event, editorId, errorId) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      $(editorId).value = JSON.stringify(data, null, 2);
      $(errorId).textContent = '';
    } catch (err) {
      $(errorId).textContent = `Invalid JSON file: ${err.message}`;
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function showStatus(id, message, type) {
  const el = $(id);
  el.textContent = message;
  el.className = `status ${type}`;
}

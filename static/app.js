// =============================================================================
// Media Upload Hub — app.js  (redesigned dual-station version)
// =============================================================================

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
let currentDevice = null;
let pendingRunId = null;
let pendingFolders = [];
let countdownTimer = null;
let speedSamples = [];
const MAX_SPEED_SAMPLES = 5;

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
const TABS = ['usb', 'extdrive', 'files', 'history', 'settings'];

document.addEventListener('DOMContentLoaded', () => {
    // Tab routing
    TABS.forEach(tab => {
        const el = document.getElementById(`tab-${tab}`);
        if (!el) return;
        el.addEventListener('click', () => switchTab(tab));
    });

    // Initial data
    fetchStorage();
    fetchSettings();
    fetchExtDriveStatus();   // populate sidebar ext storage on load
    connectWebSocket();

    // Page visibility re-sync
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            fetch('/api/state').then(r => r.json()).then(s => onStateSync(s)).catch(() => {});
            fetchStorage();
        }
    });

    // Modal buttons
    document.getElementById('modal-upload-all').addEventListener('click', () => {
        clearCountdown(); closeModal();
        const allFolderNames = pendingFolders.map(f => f.name);
        if (pendingRunId !== null) startUploadSelected(pendingRunId, allFolderNames);
        else startStagingUpload(allFolderNames);
    });

    document.getElementById('modal-upload-selected').addEventListener('click', () => {
        clearCountdown(); closeModal();
        const checked = [...document.querySelectorAll('#folder-list input[type=checkbox]:checked')];
        const selected = checked.map(cb => cb.dataset.folder);
        if (selected.length === 0) { showToast('No folders selected — upload skipped.', '⚠️'); return; }
        if (pendingRunId !== null) startUploadSelected(pendingRunId, selected);
        else startStagingUpload(selected);
    });

    document.getElementById('modal-cancel').addEventListener('click', () => {
        clearCountdown(); closeModal();
        showToast('Upload skipped.', 'ℹ️');
    });

    document.getElementById('save-settings-btn').addEventListener('click', saveSettings);
});

function switchTab(tab) {
    // Hide all views
    TABS.forEach(t => {
        const v = document.getElementById(`view-${t}`);
        if (v) { v.classList.add('hidden'); v.classList.remove('active'); }
        const n = document.getElementById(`tab-${t}`);
        if (n) { n.classList.remove('nav-active', 'nav-active-ext'); }
    });

    // Show target view
    const view = document.getElementById(`view-${tab}`);
    if (view) { view.classList.remove('hidden'); view.classList.add('active'); }

    // Activate nav item
    const navEl = document.getElementById(`tab-${tab}`);
    if (navEl) {
        if (tab === 'extdrive') navEl.classList.add('nav-active-ext');
        else navEl.classList.add('nav-active');
    }

    // Lazy load
    if (tab === 'history') fetchHistory();
    if (tab === 'files') fetchFiles();
    if (tab === 'extdrive') { fetchExtDriveStatus(); fetchExtDriveHistory(); }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
let _wsConnected = false;

function connectWebSocket() {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => { _wsConnected = true; };
    ws.onmessage = handleWsMessage;
    ws.onclose = () => { _wsConnected = false; setTimeout(connectWebSocket, 3000); };
    ws.onerror = () => {};
}

function handleWsMessage(event) {
    const payload = JSON.parse(event.data);
    const data = payload.data;
    switch (payload.event) {
        case 'state_sync':          onStateSync(data); break;
        case 'auto_copy_toggled':   updateAutoCopyBadges(data.enabled); break;
        case 'run_started':         onRunStarted(data); break;
        case 'usb_info':            onUsbInfo(data); break;
        case 'copy_progress':       onCopyProgress(data); break;
        case 'copy_stopped':        onCopyStopped(data); break;
        case 'copy_done':           onCopyDone(); break;
        case 'copy_done_select':    onCopyDoneSelect(data); break;
        case 'upload_started':      onUploadStarted(data); break;
        case 'upload_progress':     onUploadProgress(data); break;
        case 'upload_speed':        onUploadSpeed(data); break;
        case 'upload_stopped':      onUploadStopped(data); break;
        case 'upload_done':         onUploadDone(data); break;
        case 'run_completed':       onRunCompleted(data); break;
        case 'ext_run_started':     onExtRunStarted(data); break;
        case 'ext_scan_started':    onExtScanStarted(data); break;
        case 'ext_scan_done':       onExtScanDone(data); break;
        case 'ext_upload_started':  onExtUploadStarted(data); break;
        case 'ext_upload_progress': onExtUploadProgress(data); break;
        case 'ext_upload_speed':    onExtUploadSpeed(data); break;
        case 'ext_upload_stopped':  onExtUploadStopped(data); break;
        case 'ext_upload_done':     onExtUploadDone(data); break;
        case 'ext_run_completed':   onExtRunCompleted(data); break;
    }
}

// ---------------------------------------------------------------------------
// state_sync
// ---------------------------------------------------------------------------
function onStateSync(s) {
    const phase = s.phase || 'idle';
    currentDevice = s.device;
    updateAutoCopyBadges(s.auto_copy_enabled);

    if (s.usb_info && s.device && s.device !== 'local_disk') {
        onUsbInfo({ device: s.device, ...s.usb_info });
    }
    if (s.copy_total > 0) updateRing('copy', s.copy_current, s.copy_total);
    if (s.upload_total > 0) updateRing('upload', s.upload_current, s.upload_total);

    if (s.speed_mbps !== null && s.speed_mbps !== undefined) setSpeed(s.speed_mbps.toFixed(2));
    else setSpeed('—');

    switch (phase) {
        case 'copying':
            setText('local-status', s.current_file ? `Copying: ${s.current_file}` : `Copying from USB ${s.device}…`);
            setText('cloud-status', 'Waiting for local copy…');
            setBadge('copy', 'Copying'); setBadge('upload', 'Waiting', 'gray');
            showCopyControls(true); break;
        case 'copy_paused':
            setText('local-status', 'Copy paused — click Resume to continue.');
            setBadge('copy', 'Paused', 'yellow'); showCopyControls(true);
            const prBtn = document.getElementById('btn-copy-pause-resume');
            const prText = document.getElementById('copy-pause-text');
            if (prBtn && prText) { prBtn.className = 'ctrl-btn ctrl-green'; prText.innerHTML = '&#9654; Resume'; }
            break;
        case 'copy_done':
            setText('local-status', 'Local copy complete.'); setBadge('copy', 'Done', 'green');
            setText('cloud-status', 'Waiting to upload…'); showCopyControls(false); break;
        case 'copy_done_select':
            setText('local-status', 'Local copy complete.'); setBadge('copy', 'Done', 'green');
            setText('cloud-status', 'Waiting for folder selection…'); showCopyControls(false);
            if (s.folders && s.folders.length > 0) {
                pendingRunId = s.run_id; pendingFolders = s.folders;
                openFolderModal(s.folders, s.auto_upload_seconds || 30);
            } break;
        case 'uploading':
            setText('local-status', s.copy_total > 0 ? `Copy complete — ${s.copy_current}/${s.copy_total} files` : 'Local files ready.');
            setText('cloud-status', s.current_file ? `Uploading: ${s.current_file}` : 'Uploading to Google Photos…');
            setBadge('copy', 'Done', 'green'); setBadge('upload', 'Uploading', 'purple');
            document.getElementById('upload-controls').classList.remove('hidden');
            if (s.copy_total > 0) { const r = document.getElementById('copy-ring'); if (r) r.style.strokeDashoffset = 0; setText('copy-pct', '100%'); }
            break;
        case 'upload_paused':
            setText('cloud-status', 'Upload paused.'); setBadge('upload', 'Paused', 'yellow'); break;
        case 'upload_done': case 'completed':
            setText('local-status', s.copy_total > 0 ? `Complete — ${s.copy_current}/${s.copy_total} files from ${s.device || ''}` : 'Complete.');
            setText('cloud-status', s.upload_total > 0 ? `Complete — ${s.upload_current}/${s.upload_total} files uploaded` : 'Upload complete.');
            setBadge('copy', 'Done', 'green'); setBadge('upload', 'Done', 'green');
            document.getElementById('upload-controls').classList.add('hidden');
            if (s.upload_total > 0) updateRing('upload', s.upload_total, s.upload_total); break;
        case 'failed':
            setText('local-status', `Error: ${s.error || 'Unknown error'}`); setBadge('copy', 'Failed', 'red'); break;
        case 'idle': default: break;
    }

    if (phase === 'idle' || phase === 'completed' || phase === 'failed') fetchActiveDashboard();

    // Ext drive state restore
    const extPhase = s.ext_phase || 'idle';
    extState.phase = extPhase; extState.runId = s.ext_run_id;
    extState.current = s.ext_upload_current || 0; extState.total = s.ext_upload_total || 0;
    extState.speedMbps = s.ext_speed_mbps;
    if (s.ext_upload_total > 0) updateExtRing(s.ext_upload_current || 0, s.ext_upload_total);
    if (s.ext_speed_mbps !== null && s.ext_speed_mbps !== undefined) setExtSpeed(s.ext_speed_mbps.toFixed(2));
    switch (extPhase) {
        case 'scanning':   setExtPhaseBadge('Scanning', 'amber'); setExtStatusText(`Counting files… ${s.ext_upload_total > 0 ? s.ext_upload_total + ' found' : ''}`); showExtControls(true, false); break;
        case 'uploading':  setExtPhaseBadge('Uploading', 'amber'); setExtStatusText(s.ext_current_file ? `Uploading: ${s.ext_current_file}` : 'Uploading to Google Photos…'); showExtControls(true, false); break;
        case 'upload_paused': setExtPhaseBadge('Paused', 'yellow'); setExtStatusText('Upload paused.'); showExtControls(true, true); break;
        case 'upload_done': case 'completed': setExtPhaseBadge('Done', 'green'); setExtStatusText(`Complete — ${s.ext_upload_current}/${s.ext_upload_total} files uploaded.`); showExtControls(false, false); if (s.ext_upload_total > 0) updateExtRing(s.ext_upload_total, s.ext_upload_total); break;
        case 'failed': setExtPhaseBadge('Error', 'red'); setExtStatusText(`Error: ${s.ext_error || 'Unknown error'}`); showExtControls(false, false); break;
        case 'idle': default: break;
    }
}

// ---------------------------------------------------------------------------
// USB station WS handlers
// ---------------------------------------------------------------------------
function onRunStarted(data) {
    currentDevice = data.device;
    setText('local-status', data.device === 'local_disk' ? 'Uploading from staging directory...' : `Copying from USB ${data.device}...`);
    setText('cloud-status', 'Waiting for local copy...');
    document.getElementById('local-files').innerHTML = '';
    document.getElementById('cloud-files').innerHTML = '';
    setBadge('copy', data.device === 'local_disk' ? 'Uploading' : 'Copying');
    setBadge('upload', 'Waiting');
    updateRing('copy', 0, 0); updateRing('upload', 0, 0);
    speedSamples = []; setSpeed('—');
    showCopyControls(true);
}

function onUsbInfo(data) {
    const bar = document.getElementById('usb-info-bar');
    bar.classList.remove('hidden');
    setText('usb-info-device', `USB: /dev/${data.device}`);
    setText('usb-total', formatBytes(data.total));
    setText('usb-used', formatBytes(data.used));
    setText('usb-free', formatBytes(data.free));
    const pct = data.total > 0 ? (data.used / data.total * 100).toFixed(1) : 0;
    document.getElementById('usb-bar').style.width = pct + '%';
    const mb = document.getElementById('usb-mount-badge');
    mb.textContent = data.mounted ? 'Mounted' : 'Unmounted';
    mb.className = data.mounted ? 'badge badge-green' : 'badge badge-gray';
    document.getElementById('btn-unmount').dataset.device = data.device;
}

function onCopyProgress(data) {
    setText('local-status', `Copying: ${data.filename}`);
    updateRing('copy', data.current - 1, data.total);
    addFileRow('local-files', data.filename, 'copying');
}

function onCopyStopped(data) {
    setText('local-status', `Copy stopped at ${data.at} / ${data.total} files.`);
    setBadge('copy', 'Stopped', 'red'); showCopyControls(false);
}

function onCopyDone() {
    setText('local-status', 'Local copy complete.');
    setBadge('copy', 'Done', 'green'); showCopyControls(false);
    const ring = document.getElementById('copy-ring');
    if (ring) ring.style.strokeDashoffset = 0;
    setText('copy-pct', '100%');
}

function onCopyDoneSelect(data) {
    pendingRunId = data.run_id; pendingFolders = data.folders || [];
    openFolderModal(pendingFolders, data.auto_upload_seconds || 30);
}

function onUploadStarted(data) {
    setBadge('upload', 'Uploading');
    setText('cloud-status', 'Uploading to Google Photos...');
    document.getElementById('upload-controls').classList.remove('hidden');
    speedSamples = []; setSpeed('—');
}

function onUploadProgress(data) {
    const status = data.status || 'uploading';
    const filename = data.filename;
    const msgs = {
        uploading: `Checking: ${filename}`,
        uploaded: `Uploaded: ${filename}`,
        already_in_photos: `Already in Photos: ${filename}`,
        skipped: `Skipped: ${filename}`,
        failed: `⚠️ Failed: ${filename}`,
    };
    setText('cloud-status', msgs[status] || `Processing: ${filename}`);
    if (status === 'uploading') setSpeed('...', true);
    else if (status === 'already_in_photos' || status === 'skipped' || status === 'failed') setSpeed('—');
    updateRing('upload', data.current, data.total);
    addFileRow('cloud-files', filename, status);
}

function onUploadSpeed(data) {
    const mbps = data.speed_mbps;
    if (mbps === null || mbps === undefined) return;
    speedSamples.push(mbps);
    if (speedSamples.length > MAX_SPEED_SAMPLES) speedSamples.shift();
    const avg = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
    setSpeed(avg.toFixed(2));
}

function onUploadStopped(data) {
    setText('cloud-status', `Upload stopped at ${data.at} / ${data.total} files.`);
    setBadge('upload', 'Stopped', 'red');
    document.getElementById('upload-controls').classList.add('hidden');
    setSpeed('—');
}

function onUploadDone(data) {
    setText('cloud-status', 'Upload complete.');
    setBadge('upload', 'Done', 'green');
    document.getElementById('upload-controls').classList.add('hidden');
    setSpeed('—'); speedSamples = [];
    document.querySelectorAll('#cloud-files [data-file]').forEach(el => {
        const chip = el.querySelector('.status-chip');
        if (chip && chip.textContent.includes('Uploading')) chip.innerHTML = statusChip('uploaded');
    });
    fetchStorage();
}

function onRunCompleted(data) { fetchStorage(); fetchActiveDashboard(); }

// ---------------------------------------------------------------------------
// Folder Modal
// ---------------------------------------------------------------------------
function openFolderModal(folders, autoSeconds) {
    const modal = document.getElementById('folder-modal');
    const list = document.getElementById('folder-list');
    const noneMsg = document.getElementById('folder-none');
    list.innerHTML = '';
    if (!folders || folders.length === 0) {
        noneMsg.classList.remove('hidden');
    } else {
        noneMsg.classList.add('hidden');
        folders.forEach(f => {
            const div = document.createElement('div');
            div.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.05)';
            div.innerHTML = `
                <input type="checkbox" checked data-folder="${escapeAttr(f.name)}"
                    style="width:15px;height:15px;accent-color:#6366f1;cursor:pointer;flex-shrink:0">
                <div style="flex:1;min-width:0">
                    <p style="font-size:13px;font-weight:600;color:#e8eaf0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(f.name)}</p>
                    <p style="font-size:11px;color:#7c8399">${f.type === 'folder' ? `${f.file_count} files` : 'file'} · ${formatBytes(f.size)}</p>
                </div>
                <span style="font-size:16px">${f.type === 'folder' ? '📁' : '📄'}</span>
            `;
            list.appendChild(div);
        });
    }
    modal.classList.remove('hidden');
    startCountdown(autoSeconds);
}

function closeModal() { document.getElementById('folder-modal').classList.add('hidden'); }

function startCountdown(seconds) {
    const totalSeconds = seconds;
    let remaining = totalSeconds;
    const label = document.getElementById('countdown-label');
    const secEl = document.getElementById('countdown-sec');
    const ring = document.getElementById('countdown-ring');
    const circumference = 125.66;
    const tick = () => {
        if (label) label.textContent = remaining;
        if (secEl) secEl.textContent = remaining;
        if (ring) ring.style.strokeDashoffset = circumference * (1 - remaining / totalSeconds);
        if (remaining <= 0) {
            clearInterval(countdownTimer); countdownTimer = null; closeModal();
            if (pendingRunId !== null && pendingFolders.length > 0)
                startUploadSelected(pendingRunId, pendingFolders.map(f => f.name));
            return;
        }
        remaining--;
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
}

function clearCountdown() { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } }

async function startUploadSelected(runId, folders) {
    try {
        const res = await fetch('/api/upload_selected', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: runId, folders }) });
        if (res.ok) { showToast(`Uploading ${folders.length} folder(s)…`, '☁️'); setBadge('upload', 'Uploading'); document.getElementById('upload-controls').classList.remove('hidden'); }
        else showToast('Failed to start upload.', '✕');
    } catch (e) { showToast('Error starting upload.', '✕'); }
}

async function startStagingUpload(folders) {
    try {
        let started = 0;
        for (const folder of folders) {
            const res = await fetch('/api/trigger_local_upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) });
            if (res.ok) started++;
        }
        if (started > 0) { showToast(`Uploading ${started} folder(s) from staging…`, '☁️'); setBadge('upload', 'Uploading'); document.getElementById('upload-controls').classList.remove('hidden'); }
        else showToast('Failed to start upload.', '✕');
    } catch (e) { showToast('Error starting upload.', '✕'); }
}

// ---------------------------------------------------------------------------
// Copy / Upload control helpers
// ---------------------------------------------------------------------------
function showCopyControls(show) {
    const el = document.getElementById('copy-controls');
    if (show) { el.classList.remove('hidden'); el.classList.add('flex'); }
    else { el.classList.add('hidden'); el.classList.remove('flex'); }
}

async function copyPause() {
    await fetch('/api/copy/pause', { method: 'POST' });
    const prBtn = document.getElementById('btn-copy-pause-resume');
    const prText = document.getElementById('copy-pause-text');
    if (prBtn && prText) { prBtn.className = 'ctrl-btn ctrl-green'; prText.innerHTML = '&#9654; Resume'; }
    setBadge('copy', 'Paused', 'yellow');
    setText('local-status', 'Copy paused — click Resume to continue.');
}

async function copyResume() {
    await fetch('/api/copy/resume', { method: 'POST' });
    const prBtn = document.getElementById('btn-copy-pause-resume');
    const prText = document.getElementById('copy-pause-text');
    if (prBtn && prText) { prBtn.className = 'ctrl-btn ctrl-yellow'; prText.innerHTML = '⏸ Pause'; }
    setBadge('copy', 'Copying');
}

async function copyTogglePauseResume() {
    const prText = document.getElementById('copy-pause-text');
    if (prText && prText.innerText.includes('Resume')) {
        await copyResume();
    } else {
        await copyPause();
    }
}

async function copyStop() { await fetch('/api/copy/stop', { method: 'POST' }); showCopyControls(false); }
async function uploadStop() { await fetch('/api/upload/stop', { method: 'POST' }); document.getElementById('upload-controls').classList.add('hidden'); }

async function unmountUSB() {
    const device = document.getElementById('btn-unmount').dataset.device || currentDevice;
    if (!device) return;
    try {
        const res = await fetch(`/api/usb/${device}/unmount`, { method: 'POST' });
        if (res.ok) {
            const mb = document.getElementById('usb-mount-badge');
            mb.textContent = 'Unmounted'; mb.className = 'badge badge-gray';
            document.getElementById('btn-unmount').disabled = true;
            showToast('USB unmounted safely.', '✓');
        }
    } catch (e) { showToast('Failed to unmount USB.', '✕'); }
}

// ---------------------------------------------------------------------------
// Ring chart helpers — now drives flat segmented bars + hero numbers
// ---------------------------------------------------------------------------
function updateRing(type, done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    // Legacy compat (hidden elements)
    const pctEl = document.getElementById(`${type}-pct`);
    const countEl = document.getElementById(`${type}-count`);
    if (pctEl) pctEl.textContent = pct + '%';
    if (countEl) countEl.textContent = `${done} / ${total} files`;
    // New flat bar
    const segDone = document.getElementById(`${type}-seg-done`);
    const segRem  = document.getElementById(`${type}-seg-rem`);
    if (segDone) segDone.style.width = pct + '%';
    if (segRem)  segRem.style.width  = (100 - pct) + '%';
    // Hero number
    const hero = document.getElementById(`${type}-pct-hero`);
    if (hero) hero.innerHTML = `${pct}<span class="stat-unit">%</span>`;
}

function setBadge(type, label, color = 'default') {
    const el = document.getElementById(`${type}-badge`);
    if (!el) return;
    // Card-level badges use badge-corner (plain gray bordered chip)
    // Only set text, keep badge-corner class always
    el.className = 'badge-corner';
    el.textContent = label;
}

function setSpeed(value, loading = false) {
    const el = document.getElementById('upload-speed');
    if (!el) return;
    el.textContent = loading ? '... MB/s' : (value === '—' ? '— MB/s' : `${value} MB/s`);
}

function updateAutoCopyBadges(enabled) {
    const dashBadge = document.getElementById('dashboard-service-badge');
    const toggleBtn = document.getElementById('btn-toggle-service');
    if (enabled) {
        if (dashBadge) { dashBadge.textContent = 'Auto-Copy Active'; dashBadge.className = 'badge badge-green'; }
        if (toggleBtn) { toggleBtn.innerHTML = 'Stop Service'; toggleBtn.className = 'sys-btn'; }
    } else {
        if (dashBadge) { dashBadge.textContent = 'Auto-Copy Off'; dashBadge.className = 'badge badge-yellow'; }
        if (toggleBtn) { toggleBtn.innerHTML = 'Start Service'; toggleBtn.className = 'sys-btn'; }
    }
}

// ---------------------------------------------------------------------------
// File row helpers
// ---------------------------------------------------------------------------
function fileIcon(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    const isVideo = ['mp4', 'mov', 'avi', 'mkv', 'dng'].includes(ext);
    const color = isVideo ? '#3d6b9e' : '#a0a0a0';
    const bg = isVideo ? '#eef2f8' : '#f7f6f3';
    return `<div style="width:28px;height:28px;border-radius:7px;background:${bg};border:1px solid #e8e5e0;display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <svg width="13" height="13" fill="none" stroke="${color}" stroke-width="2" viewBox="0 0 24 24">
        ${isVideo
            ? '<path stroke-linecap="round" stroke-linejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>'
            : '<path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>'}
        </svg></div>`;
}

function statusChip(status) {
    const map = {
        copied:            '<span style="font-size:11px;font-weight:600;color:#2a7e5c">(Copied)</span>',
        copying:           '<span style="font-size:11px;font-weight:600;color:#3d6b9e" class="pulse-dot">(Copying…)</span>',
        uploading:         '<span style="font-size:11px;font-weight:600;color:#5b4fcf" class="pulse-dot">(Checking…)</span>',
        uploaded:          '<span style="font-size:11px;font-weight:600;color:#2a7e5c">✓ Uploaded</span>',
        already_in_photos: '<span style="font-size:11px;font-weight:600;color:#2563eb">☁ Already in Photos</span>',
        skipped:           '<span style="font-size:11px;font-weight:600;color:#c8960a">— Skipped</span>',
        failed:            '<span style="font-size:11px;font-weight:600;color:#c0392b">⚠ Failed</span>',
    };
    return map[status] || '<span style="font-size:11px;color:#a0a0a0">(Queued)</span>';
}

function addFileRow(listId, filename, status) {
    const list = document.getElementById(listId);
    if (!list) return;
    const existing = list.querySelector(`[data-file="${CSS.escape(filename)}"]`);
    if (existing) { existing.querySelector('.status-chip').innerHTML = statusChip(status); return; }
    const li = document.createElement('li');
    li.setAttribute('data-file', filename);
    li.className = 'file-row-new';
    li.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #f0ede8';
    const name = filename.split('/').pop();
    li.innerHTML = `${fileIcon(filename)}
        <div style="flex:1;min-width:0">
            <p style="font-size:12px;font-weight:600;color:#1a1a1a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}</p>
            <span class="status-chip">${statusChip(status)}</span>
        </div>`;
    list.insertBefore(li, list.firstChild);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function fetchSettings() {
    try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        document.getElementById('gp-auth-data').value = data['GP_AUTH_DATA'] || '';
        document.getElementById('upload-quality').value = data['UPLOAD_QUALITY'] || 'Original Quality';
        document.getElementById('upload-threads').value = data['UPLOAD_THREADS'] || '10';
        document.getElementById('recursive').checked   = data['RECURSIVE']      !== 'false';
        document.getElementById('auto-album').checked  = data['AUTO_ALBUM']     !== 'false';
        document.getElementById('skip-existing').checked = data['SKIP_EXISTING'] !== 'false';
        document.getElementById('delete-upload').checked = data['DELETE_UPLOAD'] === 'true';
    } catch (e) { console.error('Failed to load settings', e); }
}

async function saveSettings() {
    const settings = {
        'GP_AUTH_DATA':   document.getElementById('gp-auth-data').value,
        'UPLOAD_QUALITY': document.getElementById('upload-quality').value,
        'UPLOAD_THREADS': document.getElementById('upload-threads').value,
        'RECURSIVE':      document.getElementById('recursive').checked      ? 'true' : 'false',
        'AUTO_ALBUM':     document.getElementById('auto-album').checked      ? 'true' : 'false',
        'SKIP_EXISTING':  document.getElementById('skip-existing').checked   ? 'true' : 'false',
        'DELETE_UPLOAD':  document.getElementById('delete-upload').checked   ? 'true' : 'false',
    };
    try {
        const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) });
        if (res.ok) showToast('Settings saved ✓', '✓');
        else showToast('Failed to save settings.', '✕');
    } catch (e) { showToast('Error saving settings.', '✕'); }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
async function fetchStorage() {
    try {
        const res = await fetch('/api/system/storage');
        const data = await res.json();
        setText('storage-used', formatBytes(data.used));
        setText('storage-free', formatBytes(data.free) + ' free');
        setText('storage-total', formatBytes(data.total) + ' total');
        const percent = data.total > 0 ? (data.used / data.total) * 100 : 0;
        document.getElementById('storage-bar').style.width = percent + '%';
    } catch (e) {}
}

// ---------------------------------------------------------------------------
// Dashboard hydration from DB
// ---------------------------------------------------------------------------
async function fetchActiveDashboard() {
    try {
        const res = await fetch('/api/runs');
        const runs = await res.json();
        if (!runs || runs.length === 0) return;
        const latest = runs[0];
        updateRing('copy', latest.copied_files, latest.total_files);
        updateRing('upload', latest.uploaded_files, latest.total_files);
        if (latest.overall_status === 'running') {
            const isCopying = latest.copied_files < latest.total_files;
            setText('local-status', isCopying ? `Copying from ${latest.usb_identifier}… (${latest.copied_files}/${latest.total_files} files)` : `Copy complete — ${latest.copied_files}/${latest.total_files} files`);
            setText('cloud-status', isCopying ? 'Waiting for copy to complete…' : `Uploading to Google Photos… (${latest.uploaded_files}/${latest.total_files} files)`);
            setBadge('copy', isCopying ? 'Copying' : 'Done', isCopying ? 'default' : 'green');
            setBadge('upload', isCopying ? 'Waiting' : 'Uploading', isCopying ? 'gray' : 'purple');
        } else if (latest.overall_status === 'completed') {
            setText('local-status', `Complete — ${latest.copied_files}/${latest.total_files} files from ${latest.usb_identifier}`);
            setText('cloud-status', `Complete — ${latest.uploaded_files}/${latest.total_files} files uploaded`);
            setBadge('copy', 'Done', 'green'); setBadge('upload', 'Done', 'green');
        } else if (latest.overall_status === 'failed') {
            setText('local-status', `Last run failed for device ${latest.usb_identifier}`);
            setBadge('copy', 'Failed', 'red');
        }
        const detailRes = await fetch(`/api/runs/${latest.id}`);
        const files = await detailRes.json();
        document.getElementById('local-files').innerHTML = '';
        document.getElementById('cloud-files').innerHTML = '';
        files.slice().reverse().forEach((f, idx) => {
            let copyStatus = f.copy_status === 'success' ? 'copied' : f.copy_status === 'pending' && idx === 0 ? 'copying' : 'queued';
            addFileRow('local-files', f.filename, copyStatus);
            if (f.copy_status === 'success' || f.upload_status !== 'pending') {
                let uploadStatus = 'queued';
                if (f.upload_status === 'success') uploadStatus = f.error_message === 'already_in_photos' ? 'already_in_photos' : 'uploaded';
                else if (f.upload_status === 'skipped') uploadStatus = 'skipped';
                else if (f.upload_status === 'failed') uploadStatus = 'failed';
                addFileRow('cloud-files', f.filename, uploadStatus);
            }
        });
    } catch (e) { console.error('fetchActiveDashboard', e); }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
async function fetchHistory() {
    try {
        const res = await fetch('/api/runs');
        const runs = await res.json();
        const tbody = document.getElementById('history-body');
        tbody.innerHTML = '';
        if (!runs || runs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:#4a5068">No history yet.</td></tr>'; return;
        }
        runs.forEach(run => {
            const statusMap = { completed: 'badge badge-green', failed: 'badge badge-red', running: 'badge badge-blue' };
            const sc = statusMap[run.overall_status] || 'badge badge-gray';
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="color:#6366f1;font-weight:700">${run.id}</td>
                <td style="font-weight:600;color:#e8eaf0">${escapeHtml(run.usb_identifier)}</td>
                <td>${formatDateTime(run.start_time)}</td>
                <td style="font-weight:600;color:#6366f1">${run.copied_files} / ${run.total_files}</td>
                <td style="font-weight:600;color:#a855f7">${run.uploaded_files} / ${run.total_files}</td>
                <td><span class="${sc}">${run.overall_status}</span></td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) { console.error('fetchHistory', e); }
}

// ---------------------------------------------------------------------------
// File Explorer
// ---------------------------------------------------------------------------
let currentPath = '';

async function fetchFiles(path = '') {
    currentPath = path;
    const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
    const files = await res.json();
    const tbody = document.getElementById('files-body');
    tbody.innerHTML = '';
    if (files.length === 0) {
        tbody.innerHTML = '<tr><td colspan="2" style="text-align:center;padding:32px;color:#4a5068">No files in staging directory.</td></tr>'; return;
    }
    files.forEach(file => {
        const tr = document.createElement('tr');
        if (file.type === 'directory') {
            const newPath = file.name === '..' ? path.split('/').slice(0, -1).join('/') : (path ? path + '/' + file.name : file.name);
            tr.innerHTML = `<td onclick="fetchFiles('${escapeAttr(newPath)}')" style="cursor:pointer;color:#6366f1;font-weight:600;display:flex;align-items:center;gap:8px">
                <svg width="14" height="14" fill="#6366f1" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>
                ${escapeHtml(file.name)}</td><td>—</td>`;
        } else {
            tr.innerHTML = `<td style="color:#e8eaf0;font-weight:500">${escapeHtml(file.name)}</td><td>${formatBytes(file.size)}</td>`;
        }
        tbody.appendChild(tr);
    });
}

// ---------------------------------------------------------------------------
// Trigger manual upload (staged files)
// ---------------------------------------------------------------------------
async function triggerLocalUpload() {
    try {
        const res = await fetch('/api/staging/folders');
        const folders = await res.json();
        if (folders.length === 0) {
            const r = await fetch('/api/trigger_local_upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
            if (r.ok) showToast('Uploading staged files…', '☁️');
            else showToast('Failed to start upload.', '✕');
            return;
        }
        pendingRunId = null; pendingFolders = folders;
        openFolderModal(folders, 30);
    } catch (e) { showToast('Error fetching staged files.', '✕'); }
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(message, icon = '✓') {
    const toast = document.getElementById('toast');
    document.getElementById('toast-msg').textContent = message;
    document.getElementById('toast-icon').textContent = icon;
    toast.classList.remove('hide');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hide'), 3500);
}

// ---------------------------------------------------------------------------
// System Controls
// ---------------------------------------------------------------------------
async function systemToggleService() {
    const btn = document.getElementById('btn-toggle-service');
    const isStopping = btn && btn.textContent.trim().startsWith('Stop');
    const endpoint = isStopping ? '/api/system/stop' : '/api/system/start';
    try {
        await fetch(endpoint, { method: 'POST' });
        showToast(isStopping ? 'Auto-copy service suspended' : 'Auto-copy service started', isStopping ? '⏸️' : '▶️');
    } catch (e) { showToast('Failed to toggle service.', '✕'); }
}

async function systemRestart() {
    if (!confirm('Are you sure you want to restart the system? Any ongoing transfers will be aborted.')) return;
    try { await fetch('/api/system/restart', { method: 'POST' }); showToast('System is restarting...', '🔄'); }
    catch (e) { showToast('Failed to restart system.', '✕'); }
}

async function systemShutdown() {
    if (!confirm('Are you sure you want to shut down the system? Any ongoing transfers will be aborted.')) return;
    try { await fetch('/api/system/shutdown', { method: 'POST' }); showToast('System is shutting down...', '🔌'); }
    catch (e) { showToast('Failed to shut down system.', '✕'); }
}

// =============================================================================
// EXTERNAL DRIVE STATION — completely separate workflow
// =============================================================================

const extState = { phase: 'idle', runId: null, current: 0, total: 0, speedMbps: null };
let extSpeedSamples = [];

function onExtRunStarted(data) {
    extState.phase = 'scanning'; extState.runId = data.run_id;
    extState.current = 0; extState.total = 0; extSpeedSamples = [];
    setExtPhaseBadge('Scanning…', 'amber');
    setExtStatusText('Scanning external drive for media files…');
    showExtControls(true, false); setExtNavBadge(true);
    updateExtRing(0, 0);
    document.getElementById('ext-files').innerHTML = '';
    const em = document.getElementById('ext-files-empty'); if (em) em.classList.remove('hidden');
    fetchExtDriveHistory();
}

function onExtScanStarted(data) { setExtStatusText('Counting media files on the drive…'); }

function onExtScanDone(data) {
    extState.total = data.total || 0;
    setExtStatusText(`Found ${extState.total.toLocaleString()} media files. Starting upload…`);
    updateExtRing(0, extState.total);
}

function onExtUploadStarted(data) {
    extState.phase = 'uploading'; extState.total = data.total || 0;
    setExtPhaseBadge('Uploading', 'amber');
    setExtStatusText('Uploading to Google Photos…');
    showExtControls(true, false); updateExtRing(0, extState.total);
}

function onExtUploadProgress(data) {
    const status = data.status || 'uploading';
    const filename = data.filename || (data.filepath || '').split('/').pop();
    extState.current = data.current || 0; extState.total = data.total || extState.total;
    updateExtRing(extState.current, extState.total);
    const msgs = { uploading: `Uploading: ${filename}`, uploaded: `✓ Uploaded: ${filename}`, already_in_photos: `☁ Already in Photos: ${filename}`, skipped: `— Skipped: ${filename}`, skipped_already_uploaded: `— Previously uploaded: ${filename}`, failed: `⚠ Failed: ${filename}` };
    setExtStatusText(msgs[status] || `Processing: ${filename}`);
    if (status !== 'uploading' && status !== 'skipped_already_uploaded') addExtFileRow(filename, data.filepath || filename, status);
}

function onExtUploadSpeed(data) {
    const mbps = data.speed_mbps;
    if (mbps === null || mbps === undefined) return;
    extSpeedSamples.push(mbps);
    if (extSpeedSamples.length > 5) extSpeedSamples.shift();
    const avg = extSpeedSamples.reduce((a, b) => a + b, 0) / extSpeedSamples.length;
    setExtSpeed(avg.toFixed(2)); extState.speedMbps = avg;
}

function onExtUploadStopped(data) {
    extState.phase = 'upload_paused';
    setExtPhaseBadge('Paused', 'yellow');
    setExtStatusText(`Upload paused at ${data.at} / ${data.total} files. Click Resume to continue.`);
    showExtControls(true, true);
}

function onExtUploadDone(data) {
    extState.phase = 'upload_done';
    const { uploaded = 0, failed = 0, skipped = 0, total = extState.total } = data;
    setExtPhaseBadge('Done', 'green');
    setExtStatusText(`Complete — ${uploaded.toLocaleString()} uploaded, ${skipped} skipped, ${failed} failed.`);
    showExtControls(false, false); setExtSpeed('—'); extSpeedSamples = [];
    updateExtRing(total, total);
}

function onExtRunCompleted(data) {
    if (data.error) {
        extState.phase = 'failed'; setExtPhaseBadge('Error', 'red');
        setExtStatusText(`Error: ${data.error}`); showExtControls(false, false); setExtNavBadge(false);
    } else {
        extState.phase = 'completed'; setExtNavBadge(false); fetchExtDriveHistory();
    }
}

// --- API calls ---
async function extStartUpload() {
    if (extState.phase === 'scanning' || extState.phase === 'uploading') { showToast('Upload already in progress.', 'ℹ️'); return; }
    try {
        const res = await fetch('/api/extdrive/upload', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'already_running') showToast('Already running — check the Drive Station tab.', 'ℹ️');
        else showToast('Drive Station upload started.', '💾');
    } catch (e) { showToast('Failed to start ext drive upload.', '✕'); }
}

async function extStop() { await fetch('/api/extdrive/stop', { method: 'POST' }); showToast('Stopping ext drive upload…', '⏹️'); }

async function extPause() {
    await fetch('/api/extdrive/pause', { method: 'POST' });
    setExtPhaseBadge('Paused', 'yellow');
    setExtStatusText('Upload paused — click Resume to continue.');
}

async function extResume() {
    await fetch('/api/extdrive/resume', { method: 'POST' });
    setExtPhaseBadge('Uploading', 'amber');
}

async function extToggleStartStop() {
    if (extState.phase === 'scanning' || extState.phase === 'uploading' || extState.phase === 'upload_paused') {
        await extStop();
    } else {
        await extStartUpload();
    }
}

async function extTogglePauseResume() {
    if (extState.phase === 'upload_paused') {
        await extResume();
    } else {
        await extPause();
    }
}

async function fetchExtDriveStatus() {
    try {
        const res = await fetch('/api/extdrive/status');
        const data = await res.json();
        // Main Drive Station card
        const badge = document.getElementById('ext-mount-badge');
        if (badge) { badge.textContent = data.mounted ? 'Mounted' : 'Not Mounted'; badge.className = data.mounted ? 'badge badge-green' : 'badge badge-red'; }
        const mp = document.getElementById('ext-mount-point'); if (mp) mp.textContent = data.mount_point || '/mnt/external_drive';
        if (data.mounted && data.total > 0) {
            const t = document.getElementById('ext-total'); const u = document.getElementById('ext-used'); const f = document.getElementById('ext-free'); const bar = document.getElementById('ext-drive-bar');
            if (t) t.textContent = formatBytes(data.total);
            if (u) u.textContent = formatBytes(data.used);
            if (f) f.textContent = formatBytes(data.free);
            const pct = (data.used / data.total * 100).toFixed(1);
            if (bar) bar.style.width = pct + '%';
        }
        // Sidebar storage widget
        updateExtStorageSidebar(data);
    } catch (e) { console.error('fetchExtDriveStatus', e); }
}

function updateExtStorageSidebar(data) {
    const widget = document.getElementById('ext-storage-widget');
    const mountBadge = document.getElementById('ext-storage-mount-badge');
    if (!widget) return;
    if (!data.mounted) {
        if (mountBadge) { mountBadge.textContent = 'not mounted'; mountBadge.style.color = 'var(--red)'; }
        return;
    }
    if (mountBadge) { mountBadge.textContent = 'mounted'; mountBadge.style.color = 'var(--green)'; }
    if (data.total > 0) {
        const u = document.getElementById('ext-storage-used');
        const f = document.getElementById('ext-storage-free');
        const t = document.getElementById('ext-storage-total');
        const bar = document.getElementById('ext-storage-bar');
        if (u) u.textContent = formatBytes(data.used);
        if (f) f.textContent = formatBytes(data.free) + ' free';
        if (t) t.textContent = formatBytes(data.total) + ' total';
        const pct = (data.used / data.total * 100);
        if (bar) bar.style.width = pct + '%';
    }
}

async function fetchExtDriveHistory() {
    try {
        const res = await fetch('/api/extdrive/runs');
        const runs = await res.json();
        const tbody = document.getElementById('ext-history-body');
        if (!tbody) return;
        if (!runs || runs.length === 0) { tbody.innerHTML = '<tr><td colspan="7" class="history-empty">No sessions yet.</td></tr>'; return; }
        tbody.innerHTML = '';
        runs.forEach(run => {
            const sc = run.overall_status === 'completed' ? 'badge badge-green'
                : run.overall_status === 'completed_with_errors' ? 'badge badge-yellow'
                : run.overall_status === 'stopped' || run.overall_status === 'interrupted' ? 'badge badge-gray'
                : run.overall_status === 'failed' ? 'badge badge-red'
                : run.overall_status === 'running' ? 'badge badge-blue' : 'badge badge-gray';
            const failedCount = run.failed_files || 0;
            const actionsHtml = failedCount > 0
                ? `<button onclick="viewFailedFiles(${run.id})" style="font-size:11px;padding:3px 8px;border-radius:5px;background:rgba(239,68,68,0.12);color:#ef4444;border:none;cursor:pointer;font-weight:600">⚠ ${failedCount} Failed</button>`
                : `<span style="color:#4a5068;font-size:11px">—</span>`;
            const tr = document.createElement('tr');
            tr.id = `hist-row-${run.id}`;
            tr.innerHTML = `
                <td style="color:#7c8399">#${run.id}</td>
                <td>${formatDateTime(run.start_time)}</td>
                <td style="font-weight:700">${(run.total_files || 0).toLocaleString()}</td>
                <td style="font-weight:700;color:#22c55e">${(run.uploaded_files || 0).toLocaleString()}</td>
                <td style="font-weight:700;color:#ef4444">${failedCount.toLocaleString()}</td>
                <td><span class="${sc}">${run.overall_status}</span></td>
                <td>${actionsHtml}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) { console.error('fetchExtDriveHistory', e); }
}

// --- Failed files viewer ---
let _failedFilesPanel = null;

async function viewFailedFiles(runId) {
    if (_failedFilesPanel) {
        _failedFilesPanel.remove();
        if (_failedFilesPanel.dataset.runId == runId) { _failedFilesPanel = null; return; }
        _failedFilesPanel = null;
    }
    const tbody = document.getElementById('ext-history-body');
    const anchorRow = document.getElementById(`hist-row-${runId}`);
    if (!anchorRow || !tbody) return;
    const panelRow = document.createElement('tr');
    panelRow.dataset.runId = String(runId);
    panelRow.innerHTML = `<td colspan="7" style="padding:0;background:rgba(239,68,68,0.05);border-top:1px solid rgba(239,68,68,0.15)">
        <div style="padding:12px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
                <span style="font-size:12px;font-weight:700;color:#ef4444">⚠ Failed Files — Session #${runId}</span>
                <button id="btn-reupload-${runId}" onclick="reuploadFailed(${runId})" style="font-size:11px;padding:5px 12px;border-radius:6px;background:#ef4444;color:white;border:none;cursor:pointer;font-weight:600">↺ Re-upload All Failed</button>
            </div>
            <ul id="failed-list-${runId}" style="list-style:none;max-height:160px;overflow-y:auto;display:flex;flex-direction:column;gap:3px">
                <li style="color:#4a5068;font-size:11px;text-align:center;padding:8px">Loading…</li>
            </ul>
        </div></td>`;
    _failedFilesPanel = panelRow;
    anchorRow.insertAdjacentElement('afterend', panelRow);
    try {
        const res = await fetch(`/api/extdrive/runs/${runId}/files?status=failed&limit=500`);
        const files = await res.json();
        const list = document.getElementById(`failed-list-${runId}`);
        if (!list) return;
        if (!files || files.length === 0) { list.innerHTML = '<li style="color:#4a5068;font-size:11px;text-align:center;padding:8px">No failed files found.</li>'; return; }
        list.innerHTML = '';
        files.forEach(f => {
            const li = document.createElement('li');
            li.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;background:rgba(255,255,255,0.02);border-radius:5px;border:1px solid rgba(239,68,68,0.1)';
            const fname = f.filename || (f.filepath || '').split('/').pop();
            const errMsg = f.error_message ? `<span style="margin-left:auto;font-size:10px;color:#ef4444;flex-shrink:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeAttr(f.error_message)}">${escapeHtml(f.error_message)}</span>` : '';
            li.innerHTML = `${fileIcon(fname)}<div style="flex:1;min-width:0"><p style="font-size:11px;font-weight:600;color:#e8eaf0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(fname)}</p><p style="font-size:10px;color:#4a5068;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(f.filepath || '')}</p></div>${errMsg}<span style="font-size:10px;color:#ef4444;flex-shrink:0">⚠ Failed</span>`;
            list.appendChild(li);
        });
    } catch (e) {
        const list = document.getElementById(`failed-list-${runId}`);
        if (list) list.innerHTML = '<li style="color:#ef4444;font-size:11px;text-align:center;padding:8px">Error loading files.</li>';
    }
}

async function reuploadFailed(runId) {
    const btn = document.getElementById(`btn-reupload-${runId}`);
    if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
    try {
        const res = await fetch(`/api/extdrive/runs/${runId}/reupload`, { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.status === 'started') {
            showToast(`Re-uploading failed files from session #${runId}…`, '↺');
            if (_failedFilesPanel) { _failedFilesPanel.remove(); _failedFilesPanel = null; }
        } else if (data.status === 'already_running') {
            showToast('An upload is already running. Please wait.', 'ℹ️');
            if (btn) { btn.disabled = false; btn.textContent = '↺ Re-upload All Failed'; }
        } else {
            showToast('Failed to start re-upload.', '✕');
            if (btn) { btn.disabled = false; btn.textContent = '↺ Re-upload All Failed'; }
        }
    } catch (e) {
        showToast('Error starting re-upload.', '✕');
        if (btn) { btn.disabled = false; btn.textContent = '↺ Re-upload All Failed'; }
    }
}

// --- Ext Drive UI helpers ---
function updateExtRing(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    // Legacy compat
    const pctEl = document.getElementById('ext-pct');
    const countEl = document.getElementById('ext-count');
    if (pctEl) pctEl.textContent = pct + '%';
    if (countEl) countEl.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} files`;
    // Flat bar
    const segDone = document.getElementById('ext-seg-done');
    const segRem  = document.getElementById('ext-seg-rem');
    if (segDone) segDone.style.width = pct + '%';
    if (segRem)  segRem.style.width  = (100 - pct) + '%';
    // Hero
    const hero = document.getElementById('ext-pct-hero');
    if (hero) hero.innerHTML = `${pct}<span class="stat-unit">%</span>`;
}

function setExtPhaseBadge(label, color = 'gray') {
    const el = document.getElementById('ext-phase-badge');
    if (!el) return;
    const map = { amber: 'badge badge-amber', green: 'badge badge-green', red: 'badge badge-red', yellow: 'badge badge-yellow', gray: 'badge badge-gray' };
    el.className = map[color] || map.gray;
    el.textContent = label;
}

function setExtStatusText(text) { const el = document.getElementById('ext-status-text'); if (el) el.textContent = text; }
function setExtSpeed(value) { const el = document.getElementById('ext-speed'); if (!el) return; el.textContent = (value === '—' || !value) ? '— MB/s' : `${value} MB/s`; }

function setExtNavBadge(active) {
    const badge = document.getElementById('ext-nav-badge');
    if (!badge) return;
    if (active) badge.classList.remove('hidden'); else badge.classList.add('hidden');
}

function showExtControls(active, paused) {
    const startStopBtn = document.getElementById('btn-ext-start-stop');
    const pauseResumeBtn = document.getElementById('btn-ext-pause-resume');
    const startText = document.getElementById('ext-start-text');
    const startIcon = document.getElementById('ext-start-icon');
    const pauseText = document.getElementById('ext-pause-text');

    if (active) {
        if (startText) startText.innerText = ' Stop';
        if (startIcon) startIcon.classList.add('hidden');
        if (startStopBtn) {
            startStopBtn.className = 'ctrl-btn ctrl-red';
        }
        if (pauseResumeBtn) pauseResumeBtn.classList.remove('hidden');
        if (paused) {
            if (pauseText) pauseText.innerHTML = '&#9654; Resume';
            if (pauseResumeBtn) pauseResumeBtn.className = 'ctrl-btn ctrl-green';
        } else {
            if (pauseText) pauseText.innerHTML = '&#9646;&#9646; Pause';
            if (pauseResumeBtn) pauseResumeBtn.className = 'ctrl-btn ctrl-yellow';
        }
    } else {
        if (startText) startText.innerText = 'Start';
        if (startIcon) startIcon.classList.remove('hidden');
        if (startStopBtn) {
            startStopBtn.className = 'btn';
        }
        if (pauseResumeBtn) pauseResumeBtn.classList.add('hidden');
    }
}

function addExtFileRow(filename, fullpath, status) {
    const list = document.getElementById('ext-files');
    if (!list) return;
    const emptyMsg = document.getElementById('ext-files-empty');
    if (emptyMsg) emptyMsg.classList.add('hidden');
    const key = CSS.escape(fullpath || filename);
    const existing = list.querySelector(`[data-file="${key}"]`);
    if (existing) { const chip = existing.querySelector('.ext-status-chip'); if (chip) chip.innerHTML = extStatusChip(status); return; }
    const li = document.createElement('li');
    li.setAttribute('data-file', fullpath || filename);
    li.className = 'file-row-new';
    li.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04)';
    li.innerHTML = `${fileIcon(filename)}<div style="flex:1;min-width:0"><p style="font-size:12px;font-weight:600;color:#e8eaf0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(filename)}</p><span class="ext-status-chip">${extStatusChip(status)}</span></div>`;
    list.insertBefore(li, list.firstChild);
    while (list.children.length > 60) list.removeChild(list.lastChild);
}

function extStatusChip(status) {
    const map = {
        uploading:                '<span style="font-size:11px;font-weight:600;color:#f59e0b" class="pulse-dot">(Uploading…)</span>',
        uploaded:                 '<span style="font-size:11px;font-weight:600;color:#22c55e">✓ Uploaded</span>',
        already_in_photos:        '<span style="font-size:11px;font-weight:600;color:#38bdf8">☁ Already in Photos</span>',
        skipped:                  '<span style="font-size:11px;font-weight:600;color:#7c8399">— Skipped</span>',
        skipped_already_uploaded: '<span style="font-size:11px;font-weight:600;color:#7c8399">— Previously uploaded</span>',
        failed:                   '<span style="font-size:11px;font-weight:600;color:#ef4444">⚠ Failed</span>',
    };
    return map[status] || '<span style="font-size:11px;color:#4a5068">(Queued)</span>';
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------
function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

function formatBytes(bytes, decimals = 1) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

function formatDateTime(isoStr) {
    if (!isoStr) return '—';
    const utc = isoStr.endsWith('Z') || isoStr.includes('+') ? isoStr : isoStr + 'Z';
    const d = new Date(utc);
    if (isNaN(d)) return isoStr;
    return d.toLocaleString();
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

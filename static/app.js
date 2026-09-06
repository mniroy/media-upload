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
// Navigation & Mobile Drawer
// ---------------------------------------------------------------------------
const TABS = ['usb', 'extdrive', 'upload', 'download', 'files', 'history', 'settings'];

function openSidebarDrawer() {
    const sidebar = document.getElementById('app-sidebar') || document.querySelector('.sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar) sidebar.classList.add('drawer-open');
    if (backdrop) backdrop.classList.remove('hidden');
    document.body.classList.add('drawer-active');
}

function closeSidebarDrawer() {
    const sidebar = document.getElementById('app-sidebar') || document.querySelector('.sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar) sidebar.classList.remove('drawer-open');
    if (backdrop) backdrop.classList.add('hidden');
    document.body.classList.remove('drawer-active');
}

function toggleSidebarDrawer() {
    const sidebar = document.getElementById('app-sidebar') || document.querySelector('.sidebar');
    if (sidebar && sidebar.classList.contains('drawer-open')) {
        closeSidebarDrawer();
    } else {
        openSidebarDrawer();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Tab routing for all elements with data-tab (sidebar & bottom nav)
    document.querySelectorAll('[data-tab]').forEach(el => {
        el.addEventListener('click', (e) => {
            const tab = el.getAttribute('data-tab');
            if (tab) {
                switchTab(tab);
                closeSidebarDrawer();
            }
        });
    });

    // Mobile drawer toggles
    const btnTopMenu = document.getElementById('btn-mobile-menu-top');
    if (btnTopMenu) btnTopMenu.addEventListener('click', toggleSidebarDrawer);

    const btnBottomMenu = document.getElementById('btn-bottom-menu');
    if (btnBottomMenu) btnBottomMenu.addEventListener('click', toggleSidebarDrawer);

    const btnCloseSidebar = document.getElementById('sidebar-close-btn');
    if (btnCloseSidebar) btnCloseSidebar.addEventListener('click', closeSidebarDrawer);

    const backdrop = document.getElementById('sidebar-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeSidebarDrawer);

    // Initial data
    fetchStorage();
    fetchNetworkSpeed();
    fetchSettings();
    fetchSmbStatus();
    fetchExtDriveStatus();   // populate sidebar ext storage on load
    initUploadStationDragAndDrop();
    switchTab('upload');
    initPwa();
    connectWebSocket();

    // Page visibility re-sync
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            fetch('/api/state').then(r => r.json()).then(s => onStateSync(s)).catch(() => {});
            fetchStorage();
            fetchNetworkSpeed();
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
    // Hide all views & clear active states
    TABS.forEach(t => {
        const v = document.getElementById(`view-${t}`);
        if (v) { v.classList.add('hidden'); v.classList.remove('active'); }
        document.querySelectorAll(`[data-tab="${t}"]`).forEach(el => {
            el.classList.remove('nav-active', 'nav-active-ext', 'nav-active-upload', 'nav-active-download', 'active');
        });
    });

    // Show target view
    const view = document.getElementById(`view-${tab}`);
    if (view) { view.classList.remove('hidden'); view.classList.add('active'); }

    // Activate nav items for this tab (both in sidebar and bottom navigation)
    document.querySelectorAll(`[data-tab="${tab}"]`).forEach(navEl => {
        if (tab === 'extdrive') {
            navEl.classList.add('nav-active-ext', 'active');
        } else if (tab === 'upload') {
            navEl.classList.add('nav-active-upload', 'active');
        } else if (tab === 'download') {
            navEl.classList.add('nav-active-download', 'active');
        } else {
            navEl.classList.add('nav-active', 'active');
        }
    });

    // Update mobile top header subtitle
    const mobileTitle = document.getElementById('mobile-header-title');
    if (mobileTitle) {
        const titles = {
            usb: 'USB Station',
            extdrive: 'Drive Station',
            upload: 'Upload Station',
            download: 'Download Station',
            files: 'File Explorer',
            history: 'History',
            settings: 'Settings'
        };
        mobileTitle.textContent = titles[tab] || 'Media Hub';
    }

    // Lazy load
    if (tab === 'history') fetchHistory();
    if (tab === 'settings') { fetchSettings(); fetchSmbStatus(); }
    if (tab === 'extdrive') { fetchExtDriveStatus(); fetchExtDriveHistory(); fetchExtLiveFiles(); fetchSmbStatus(); }
    if (tab === 'upload') { fetchUploadStationStatus(); fetchUploadStationLiveFiles(); fetchUploadStationHistory(); }
    if (tab === 'download') {
        initDownloadStationBrowser();
        fetchDownloadStationStatus();
        fetchDownloadStationLiveFiles();
        fetchDownloadStationHistory();
    }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
let _wsConnected = false;

function connectWebSocket() {
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProto}//${location.host}/ws`);
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
        case 'ext_upload_progress':      onExtUploadProgress(data); break;
        case 'ext_file_byte_progress':   onExtFileByteProgress(data); break;
        case 'ext_upload_speed':         onExtUploadSpeed(data); break;
        case 'ext_upload_stopped':  onExtUploadStopped(data); break;
        case 'ext_upload_done':     onExtUploadDone(data); break;
        case 'ext_run_completed':   onExtRunCompleted(data); break;
        case 'ext_drive_status':    onExtDriveStatus(data); break;
        // Upload Station WS events
        case 'upload_station_run_started':  onUploadStationRunStarted(data); break;
        case 'upload_station_file_start':    onUploadStationFileStart(data); break;
        case 'upload_station_progress':      onUploadStationProgress(data); break;
        case 'upload_station_speed':         onUploadStationSpeed(data); break;
        case 'upload_station_file_done':     onUploadStationFileDone(data); break;
        case 'upload_station_file_failed':   onUploadStationFileFailed(data); break;
        case 'upload_station_stopped':       onUploadStationStopped(data); break;
        case 'upload_station_completed':     onUploadStationCompleted(data); break;
        // Download Station WS events
        case 'download_station_run_started':       onDownloadStationRunStarted(data); break;
        case 'download_station_file_start':         onDownloadStationFileStart(data); break;
        case 'download_station_download_progress':  onDownloadStationDownloadProgress(data); break;
        case 'download_station_download_done':      onDownloadStationDownloadDone(data); break;
        case 'download_station_upload_start':       onDownloadStationUploadStart(data); break;
        case 'download_station_upload_progress':    onDownloadStationUploadProgress(data); break;
        case 'download_station_speed':              onDownloadStationSpeed(data); break;
        case 'download_station_file_done':          onDownloadStationFileDone(data); break;
        case 'download_station_file_failed':        onDownloadStationFileFailed(data); break;
        case 'download_station_stopped':            onDownloadStationStopped(data); break;
        case 'download_station_completed':          onDownloadStationCompleted(data); break;
        case 'net_speed':           onNetSpeed(data); break;
    }
}

// ---------------------------------------------------------------------------
// state_sync
// ---------------------------------------------------------------------------
function onStateSync(s) {
    const phase = s.phase || 'idle';
    currentDevice = s.device;
    updateAutoCopyBadges(s.auto_copy_enabled);

    if (s.net_rx_mb_s !== undefined || s.net_tx_mb_s !== undefined) {
        onNetSpeed({ rx_mb_s: s.net_rx_mb_s, tx_mb_s: s.net_tx_mb_s });
    }

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
    initExtRunBytes(s.ext_run_id, s.ext_upload_current, s.ext_upload_total);
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
    
    // Automatically load live feed files for the current session
    fetchExtLiveFiles();

    // Upload Station state restore
    const uploadPhase = s.upload_station_phase || 'idle';
    uploadStationState.phase = uploadPhase;
    uploadStationState.runId = s.upload_station_run_id;
    uploadStationState.current = s.upload_station_current || 0;
    uploadStationState.total = s.upload_station_total || 0;
    uploadStationState.uploaded = s.upload_station_uploaded || 0;
    uploadStationState.failed = s.upload_station_failed || 0;
    uploadStationState.skipped = s.upload_station_skipped || 0;
    uploadStationState.bytesDone = s.upload_station_bytes_done || 0;
    uploadStationState.bytesTotal = s.upload_station_bytes_total || 0;
    uploadStationState.speedMbps = s.upload_station_speed_mbps;
    uploadStationState.currentFile = s.upload_station_current_file;
    updateUploadStationUI();
    fetchUploadStationLiveFiles();

    // Download Station state restore
    const downloadPhase = s.download_station_phase || 'idle';
    downloadStationState.phase = downloadPhase;
    downloadStationState.subphase = s.download_station_subphase || 'idle';
    downloadStationState.runId = s.download_station_run_id;
    downloadStationState.current = s.download_station_current || 0;
    downloadStationState.total = s.download_station_total || 0;
    downloadStationState.downloaded = s.download_station_downloaded || 0;
    downloadStationState.uploaded = s.download_station_uploaded || 0;
    downloadStationState.failed = s.download_station_failed || 0;
    downloadStationState.skipped = s.download_station_skipped || 0;
    downloadStationState.bytesDone = s.download_station_bytes_done || 0;
    downloadStationState.bytesTotal = s.download_station_bytes_total || 0;
    downloadStationState.speedMbps = s.download_station_speed_mbps;
    downloadStationState.currentFile = s.download_station_current_file;
    downloadStationState.destDir = s.download_station_dest_dir || '/mnt/external_drive/Downloads';
    updateDownloadStationUI();
    fetchDownloadStationLiveFiles();
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
    const isVideo = ['mp4', 'mov', 'avi', 'mkv', 'm4v', '3gp', 'wmv', 'flv', 'mts', 'm2ts', 'ts'].includes(ext);
    const isRaw = ['dng', 'raw', 'arw', 'cr2', 'cr3', 'nef', 'orf', 'rw2', 'pef', 'srw', 'raf'].includes(ext);
    
    if (isVideo) {
        return `<div style="width:28px;height:28px;border-radius:6px;background:rgba(168,85,247,0.15);border:1px solid rgba(168,85,247,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="13" height="13" fill="none" stroke="#c084fc" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
                <path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
        </div>`;
    }
    if (isRaw) {
        return `<div style="width:28px;height:28px;border-radius:6px;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="13" height="13" fill="none" stroke="#fbbf24" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/>
            </svg>
        </div>`;
    }
    return `<div style="width:28px;height:28px;border-radius:6px;background:rgba(56,189,248,0.15);border:1px solid rgba(56,189,248,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <svg width="13" height="13" fill="none" stroke="#38bdf8" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
        </svg>
    </div>`;
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
// SMB Network File Sharing
// ---------------------------------------------------------------------------
let _smbStatusData = null;

async function fetchSmbStatus() {
    try {
        const res = await fetch('/api/smb/status');
        if (!res.ok) return;
        const data = await res.json();
        _smbStatusData = data;

        const badge = document.getElementById('smb-status-badge');
        if (badge) {
            if (data.running) {
                badge.className = 'badge badge-green';
                badge.textContent = `● Running (${data.lan_ip}:445)`;
            } else if (data.installed) {
                badge.className = 'badge badge-yellow';
                badge.textContent = '● Stopped';
            } else {
                badge.className = 'badge badge-red';
                badge.textContent = 'Not Installed';
            }
        }

        const internalShare = (data.shares || []).find(s => s.name === 'Internal');
        const externalShare = (data.shares || []).find(s => s.name === 'External');

        if (internalShare) {
            setText('smb-mac-url-internal', internalShare.mac_url);
            setText('smb-win-url-internal', internalShare.win_url);
            const internalAvail = document.getElementById('smb-internal-avail');
            if (internalAvail) {
                internalAvail.className = internalShare.available ? 'badge-subtle badge-green' : 'badge-subtle badge-gray';
                internalAvail.textContent = internalShare.available ? 'Ready' : 'Not Found';
            }
        }

        if (externalShare) {
            setText('smb-mac-url-external', externalShare.mac_url);
            setText('smb-win-url-external', externalShare.win_url);
            setText('smb-ext-path', externalShare.path);
            const externalAvail = document.getElementById('smb-external-avail');
            if (externalAvail) {
                externalAvail.className = externalShare.available ? 'badge-subtle badge-green' : 'badge-subtle badge-yellow';
                externalAvail.textContent = externalShare.available ? 'Ready' : 'Not Mounted';
            }
            // Update quick pill on Drive Station
            setText('ext-smb-pill-text', externalShare.mac_url);
        }

        if (data.summary) {
            setText('guide-mac-url', `${data.summary.mac_root}/External`);
            setText('guide-win-url', `${data.summary.win_root}\\External`);
        }
    } catch (e) {
        console.error('Failed to load SMB status', e);
    }
}

async function copySmbText(elementIdOrText, label = 'SMB URL') {
    let textToCopy = elementIdOrText;
    const el = document.getElementById(elementIdOrText);
    if (el) {
        textToCopy = el.textContent || el.innerText || '';
    }
    if (!textToCopy) return;

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(textToCopy);
        } else {
            const tempInput = document.createElement('input');
            tempInput.value = textToCopy;
            document.body.appendChild(tempInput);
            tempInput.select();
            document.execCommand('copy');
            document.body.removeChild(tempInput);
        }
        showToast(`Copied ${label} to clipboard ✓`, '📋');
    } catch (err) {
        showToast('Failed to copy to clipboard', '✕');
    }
}

function copySmbShare(shareName) {
    if (!_smbStatusData) {
        copySmbText(`smb://${window.location.hostname}/${shareName}`, `${shareName} Share`);
        return;
    }
    const share = (_smbStatusData.shares || []).find(s => s.name.toLowerCase() === shareName.toLowerCase());
    if (share) {
        copySmbText(share.mac_url, `${share.name} Share`);
    } else {
        copySmbText(`smb://${_smbStatusData.lan_ip}/${shareName}`, `${shareName} Share`);
    }
}

async function restartSmbService() {
    if (!confirm('Restart Samba (SMB) file sharing daemon?')) return;
    try {
        showToast('Restarting SMB service…', '⏳');
        const res = await fetch('/api/smb/restart', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast(data.message || 'SMB restarted ✓', '✓');
            setTimeout(fetchSmbStatus, 1500);
        } else {
            showToast(data.message || 'Failed to restart SMB.', '✕');
        }
    } catch (e) {
        showToast('Error restarting SMB service.', '✕');
    }
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

const extState = {
    phase: 'idle',
    runId: null,
    current: 0,
    total: 0,
    speedMbps: null,
    uploadedBytes: 0,
    totalBytes: 0,
    currentFileBytesSent: 0,
    currentFileSize: 0,
    fileSizeSamples: []
};
let extSpeedSamples = [];

function initExtRunBytes(runId, currentCount, totalCount) {
    if (!runId) return;
    const knownRuns = {
        16: { baselineUploaded: 72218164885, totalBytes: 1119656313139 }
    };
    const info = knownRuns[runId] || {};

    if (info.totalBytes) {
        extState.totalBytes = info.totalBytes;
    } else if (totalCount === 7849) {
        extState.totalBytes = 1119656313139;
    } else if (totalCount > 0) {
        const savedTotal = localStorage.getItem('ext_run_total_bytes_' + runId);
        if (savedTotal) extState.totalBytes = parseFloat(savedTotal);
    }

    const savedUploaded = localStorage.getItem('ext_run_uploaded_bytes_' + runId);
    if (savedUploaded) {
        const val = parseFloat(savedUploaded);
        if (info.baselineUploaded) extState.uploadedBytes = Math.max(val, info.baselineUploaded);
        else extState.uploadedBytes = val;
    } else if (info.baselineUploaded) {
        extState.uploadedBytes = info.baselineUploaded;
    } else if (currentCount > 0 && extState.totalBytes && totalCount > 0) {
        extState.uploadedBytes = Math.round((currentCount / totalCount) * extState.totalBytes);
    }
}

function onExtRunStarted(data) {
    extState.phase = 'scanning'; extState.runId = data.run_id;
    extState.current = 0; extState.total = 0; extSpeedSamples = [];
    extState.uploadedBytes = 0; extState.totalBytes = 0;
    extState.currentFileBytesSent = 0; extState.currentFileSize = 0;
    extState.fileSizeSamples = [];
    setExtPhaseBadge('Scanning…', 'amber');
    setExtStatusText('Scanning external drive for media files…');
    showExtControls(true, false); setExtNavBadge(true);
    updateExtRing(0, 0);
    document.getElementById('ext-files').innerHTML = '';
    const em = document.getElementById('ext-files-empty'); if (em) em.classList.remove('hidden');
    fetchExtDriveHistory();
}

function onExtScanStarted(data) { setExtStatusText('Pre-checking local database & scanning drive…'); }

function onExtScanDone(data) {
    extState.total = data.total || 0;
    extState.alreadyUploaded = data.already_uploaded || 0;
    extState.totalDisk = data.total_disk || extState.total;
    if (extState.total === 0) {
        setExtStatusText(`All ${extState.totalDisk.toLocaleString()} files are already in local database.`);
    } else {
        setExtStatusText(`Found ${extState.totalDisk.toLocaleString()} files (${extState.alreadyUploaded.toLocaleString()} already in local DB) • ${extState.total.toLocaleString()} pending to upload`);
    }
    updateExtRing(0, extState.total);
}

function onExtUploadStarted(data) {
    extState.phase = 'uploading';
    extState.total = data.total || 0;
    extState.alreadyUploaded = data.already_uploaded || 0;
    extState.totalDisk = data.total_disk || extState.total;
    initExtRunBytes(extState.runId, 0, extState.total);
    setExtPhaseBadge('Uploading', 'amber');
    setExtStatusText(`Uploading ${extState.total.toLocaleString()} pending files (${extState.alreadyUploaded.toLocaleString()} already in local DB)…`);
    showExtControls(true, false);
    updateExtRing(0, extState.total);
    fetchExtLiveFiles();
}

function onExtUploadProgress(data) {
    const status = data.status || 'uploading';
    const filename = data.filename || (data.filepath || '').split('/').filter(Boolean).pop();
    extState.current = data.current || 0;
    extState.total = data.total || extState.total;
    if (!extState.uploadedBytes && extState.runId) {
        initExtRunBytes(extState.runId, extState.current, extState.total);
    }

    if (data.file_size && data.file_size > 0) {
        extState.fileSizeSamples.push(data.file_size);
        if (extState.fileSizeSamples.length > 500) extState.fileSizeSamples.shift();
    }

    if (status === 'uploaded' || status === 'already_in_photos') {
        const sz = data.file_size || extState.currentFileSize || 0;
        extState.uploadedBytes += sz;
        extState.currentFileBytesSent = 0;
        extState.currentFileSize = 0;
        if (extState.runId) {
            localStorage.setItem('ext_run_uploaded_bytes_' + extState.runId, extState.uploadedBytes);
        }
    }

    updateExtRing(extState.current, extState.total);
    const msgs = {
        uploading: `Uploading (${extState.current}/${extState.total}): ${filename}`,
        uploaded: `✓ Uploaded: ${filename}`,
        already_in_photos: `☁ Already in Photos: ${filename}`,
        skipped: `— Skipped: ${filename}`,
        failed: `⚠ Failed: ${filename}`
    };
    setExtStatusText(msgs[status] || `Processing: ${filename}`);
    if (status !== 'uploading' && status !== 'skipped_already_uploaded') {
        addExtFileRow(filename, data.filepath || filename, status, data.error_message);
    }
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
    setExtStatusText(`Complete — ${uploaded.toLocaleString()} uploaded, ${skipped.toLocaleString()} skipped/already in DB, ${failed.toLocaleString()} failed.`);
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
        renderExtDriveStatus(data);
    } catch (e) { console.error('fetchExtDriveStatus', e); }
}

function onExtDriveStatus(data) {
    renderExtDriveStatus(data);
}

function renderExtDriveStatus(data) {
    // Main Drive Station card
    const badge = document.getElementById('ext-mount-badge');
    if (badge) {
        badge.textContent = data.mounted ? 'Mounted' : 'Not Mounted';
        badge.className = data.mounted ? 'badge badge-green' : 'badge badge-red';
    }
    const mp = document.getElementById('ext-mount-point');
    if (mp) mp.textContent = data.mount_point || '/mnt/external_drive';

    const t = document.getElementById('ext-total');
    const u = document.getElementById('ext-used');
    const f = document.getElementById('ext-free');
    const bar = document.getElementById('ext-drive-bar');

    if (data.mounted && data.total > 0) {
        if (t) t.textContent = formatBytes(data.total);
        if (u) u.textContent = formatBytes(data.used);
        if (f) f.textContent = formatBytes(data.free);
        const pct = (data.used / data.total * 100).toFixed(1);
        if (bar) bar.style.width = pct + '%';
    } else {
        if (t) t.textContent = '--';
        if (u) u.textContent = '--';
        if (f) f.textContent = '--';
        if (bar) bar.style.width = '0%';
    }
    // Sidebar storage widget
    updateExtStorageSidebar(data);
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

function onNetSpeed(data) {
    const rx = data.rx_mb_s || 0;
    const tx = data.tx_mb_s || 0;
    const rxEl = document.getElementById('net-speed-rx');
    const txEl = document.getElementById('net-speed-tx');
    if (rxEl) {
        if (rx >= 1.0) rxEl.innerHTML = `${rx.toFixed(2)} <small>MB/s</small>`;
        else if (rx > 0.005) rxEl.innerHTML = `${(rx * 1024).toFixed(0)} <small>KB/s</small>`;
        else rxEl.innerHTML = `0.00 <small>MB/s</small>`;
    }
    if (txEl) {
        if (tx >= 1.0) txEl.innerHTML = `${tx.toFixed(2)} <small>MB/s</small>`;
        else if (tx > 0.005) txEl.innerHTML = `${(tx * 1024).toFixed(0)} <small>KB/s</small>`;
        else txEl.innerHTML = `0.00 <small>MB/s</small>`;
    }
}

async function fetchNetworkSpeed() {
    try {
        const res = await fetch('/api/system/network');
        if (!res.ok) return;
        const data = await res.json();
        onNetSpeed(data);
    } catch (e) {}
}

async function fetchExtDriveHistory() {
    try {
        const res = await fetch('/api/extdrive/runs');
        const runs = await res.json();
        const tbody = document.getElementById('ext-history-body');
        if (!tbody) return;
        if (!runs || runs.length === 0) { tbody.innerHTML = '<tr><td colspan="8" class="history-empty">No sessions yet.</td></tr>'; return; }
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
                : `<span style="color:#64748b;font-size:11px">—</span>`;
            const tr = document.createElement('tr');
            tr.id = `hist-row-${run.id}`;
            tr.innerHTML = `
                <td style="color:#94a3b8;font-weight:600">#${run.id}</td>
                <td>${formatDateTime(run.start_time)}</td>
                <td style="font-weight:700;color:#f8fafc">${(run.total_files || 0).toLocaleString()}</td>
                <td style="font-weight:700;color:#4ade80">${(run.uploaded_files || 0).toLocaleString()}</td>
                <td style="font-weight:700;color:#f87171">${failedCount.toLocaleString()}</td>
                <td style="font-weight:600;color:#94a3b8">${(run.skipped_files || 0).toLocaleString()}</td>
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
    panelRow.innerHTML = `<td colspan="8" style="padding:0;background:rgba(239,68,68,0.05);border-top:1px solid rgba(239,68,68,0.15)">
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
    const pctEl = document.getElementById('ext-pct');
    const countEl = document.getElementById('ext-count');
    const bytesEl = document.getElementById('ext-bytes') || document.getElementById('ext-speed');

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

    // Size stats (Total GB uploaded vs total need to upload)
    if (bytesEl) {
        const doneBytes = (extState.uploadedBytes || 0) + (extState.currentFileBytesSent || 0);
        let totalEstBytes = extState.totalBytes || 0;
        if (!totalEstBytes && total > 0) {
            if (total === 7849) totalEstBytes = 1119656313139;
            else if (done > 0 && doneBytes > 0) totalEstBytes = Math.max(doneBytes, Math.round((doneBytes / done) * total));
        }
        if (doneBytes > 0 || totalEstBytes > 0) {
            bytesEl.textContent = `${formatBytes(doneBytes)} / ${formatBytes(totalEstBytes || doneBytes)}`;
        } else {
            bytesEl.textContent = '0 B / 0 B';
        }
    }
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

function createExtFileRowElement(filename, fullpath, status, errorMsg, byteProgress) {
    const li = document.createElement('li');
    li.setAttribute('data-file', fullpath || filename);
    li.className = 'file-row-new';

    // Extract clean relative directory
    let dir = '';
    if (fullpath) {
        const parts = fullpath.replace('/mnt/external_drive/', '').split('/');
        if (parts.length > 1) {
            parts.pop();
            dir = parts.join(' / ');
        }
    }

    const dirHtml = dir ? `<div class="file-row-path" title="${escapeAttr(fullpath)}">${escapeHtml(dir)}</div>` : '';
    const errHtml = (status === 'failed' && errorMsg) ? `<div style="font-size:10.5px;color:#991b1b;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeAttr(errorMsg)}">${escapeHtml(errorMsg)}</div>` : '';

    const isUploading = (status === 'uploading');
    const pct = byteProgress ? byteProgress.pct : 0;
    const bytesText = byteProgress ? `${formatBytes(byteProgress.bytes_sent)} / ${formatBytes(byteProgress.total_bytes)}` : '';

    // Only render progress bar if actively uploading
    const progHtml = (isUploading && byteProgress) ? `
        <div class="file-progress-wrap">
            <div class="file-progress-track">
                <div class="file-progress-fill" style="width: ${pct}%"></div>
            </div>
            <div class="file-progress-meta">
                <span class="file-progress-pct">${pct}%</span>
                <span class="file-progress-bytes">${bytesText}</span>
            </div>
        </div>
    ` : '';

    let displayName = filename;
    if (!displayName || displayName === '.') {
        displayName = fullpath ? fullpath.split('/').filter(Boolean).pop() : 'Unknown file';
    }

    li.innerHTML = `
        <div class="file-row-main" style="flex:1;min-width:0">
            <div class="file-row-filename" title="${escapeAttr(displayName)}">${escapeHtml(displayName)}</div>
            ${dirHtml}
            ${errHtml}
            ${progHtml}
        </div>
        <div class="ext-status-chip">
            ${extStatusChip(status, errorMsg, isUploading ? pct : undefined)}
        </div>
    `;
    return li;
}

function addExtFileRow(filename, fullpath, status, errorMsg, byteProgress) {
    const list = document.getElementById('ext-files');
    if (!list) return;
    const emptyMsg = document.getElementById('ext-files-empty');
    if (emptyMsg) emptyMsg.classList.add('hidden');

    const key = CSS.escape(fullpath || filename);
    const existing = list.querySelector(`[data-file="${key}"]`);
    if (existing) {
        const isUploading = (status === 'uploading');
        const chip = existing.querySelector('.ext-status-chip');
        if (chip) chip.innerHTML = extStatusChip(status, errorMsg, isUploading && byteProgress ? byteProgress.pct : undefined);
        const wrap = existing.querySelector('.file-progress-wrap');
        if (!isUploading && wrap) {
            wrap.remove(); // Remove progress bar completely once uploaded
        }
        return;
    }

    const li = createExtFileRowElement(filename, fullpath, status, errorMsg, byteProgress);
    list.insertBefore(li, list.firstChild);
    while (list.children.length > 250) list.removeChild(list.lastChild);

    const countBadge = document.getElementById('ext-feed-count');
    if (countBadge) countBadge.textContent = `${list.children.length} files`;
}

function onExtFileByteProgress(data) {
    const list = document.getElementById('ext-files');
    if (!list) return;
    const emptyMsg = document.getElementById('ext-files-empty');
    if (emptyMsg) emptyMsg.classList.add('hidden');

    let filename = data.filename;
    if (!filename || filename === '.') {
        filename = (data.filepath || '').split('/').filter(Boolean).pop();
    }
    const key = CSS.escape(data.filepath || filename);
    let existing = list.querySelector(`[data-file="${key}"]`);
    if (!existing) {
        addExtFileRow(filename, data.filepath || filename, 'uploading', null, data);
        existing = list.querySelector(`[data-file="${key}"]`);
    }
    if (!existing) return;

    let wrap = existing.querySelector('.file-progress-wrap');
    if (!wrap) {
        const textCol = existing.querySelector('.file-row-main');
        if (textCol) {
            wrap = document.createElement('div');
            wrap.className = 'file-progress-wrap';
            wrap.innerHTML = `
                <div class="file-progress-track">
                    <div class="file-progress-fill" style="width: ${data.pct}%"></div>
                </div>
                <div class="file-progress-meta">
                    <span class="file-progress-pct">${data.pct}%</span>
                    <span class="file-progress-bytes">${formatBytes(data.bytes_sent)} / ${formatBytes(data.total_bytes)}</span>
                </div>
            `;
            textCol.appendChild(wrap);
        }
    } else {
        const fill = wrap.querySelector('.file-progress-fill');
        const pctEl = wrap.querySelector('.file-progress-pct');
        const bytesEl = wrap.querySelector('.file-progress-bytes');
        if (fill) fill.style.width = `${data.pct}%`;
        if (pctEl) pctEl.textContent = `${data.pct}%`;
        if (bytesEl) bytesEl.textContent = `${formatBytes(data.bytes_sent)} / ${formatBytes(data.total_bytes)}`;
    }

    const chip = existing.querySelector('.ext-status-chip');
    if (chip) chip.innerHTML = extStatusChip('uploading', null, data.pct);

    extState.current = data.current || extState.current;
    extState.total = data.total || extState.total;
    extState.currentFileBytesSent = data.bytes_sent || 0;
    extState.currentFileSize = data.total_bytes || 0;
    if (data.total_bytes && data.total_bytes > 0) {
        extState.fileSizeSamples.push(data.total_bytes);
        if (extState.fileSizeSamples.length > 500) extState.fileSizeSamples.shift();
    }
    updateExtRing(extState.current, extState.total);
}

function extStatusChip(status, errorMsg, pct) {
    if (status === 'uploading') {
        const pctLabel = (pct !== undefined && pct !== null && pct > 0) ? ` ${pct}%` : '…';
        return `<span class="chip-status chip-uploading pulse-dot">⏳ Uploading${pctLabel}</span>`;
    }
    if (status === 'uploaded' || status === 'success') {
        if (errorMsg === 'already_in_photos') {
            return '<span class="chip-status chip-already">☁ Already in Photos</span>';
        }
        return '<span class="chip-status chip-uploaded">✓ Uploaded</span>';
    }
    if (status === 'already_in_photos') {
        return '<span class="chip-status chip-already">☁ Already in Photos</span>';
    }
    if (status === 'failed') {
        const title = errorMsg ? ` title="${escapeAttr(errorMsg)}"` : '';
        return `<span class="chip-status chip-failed"${title}>⚠ Failed</span>`;
    }
    if (status === 'skipped' || status === 'skipped_already_uploaded') {
        const title = errorMsg ? ` title="${escapeAttr(errorMsg)}"` : '';
        return `<span class="chip-status chip-skipped"${title}>— Skipped</span>`;
    }
    return '<span class="chip-status chip-queued">(Queued)</span>';
}

async function fetchExtLiveFiles() {
    try {
        const res = await fetch('/api/extdrive/live_files?limit=150');
        if (!res.ok) return;
        const data = await res.json();
        const list = document.getElementById('ext-files');
        const emptyMsg = document.getElementById('ext-files-empty');
        const countBadge = document.getElementById('ext-feed-count');
        if (!list) return;

        if (!data.files || data.files.length === 0) {
            list.innerHTML = '';
            if (emptyMsg) emptyMsg.classList.remove('hidden');
            if (countBadge) countBadge.textContent = '0 files';
            return;
        }

        if (emptyMsg) emptyMsg.classList.add('hidden');
        if (countBadge) countBadge.textContent = `${data.files.length} files`;

        list.innerHTML = '';
        data.files.forEach(f => {
            const fname = f.filename || (f.filepath ? f.filepath.split('/').pop() : '');
            const li = createExtFileRowElement(fname, f.filepath, f.upload_status, f.error_message);
            list.appendChild(li);
        });
        if (list.children.length > 0 && emptyMsg) {
            emptyMsg.classList.add('hidden');
        }
    } catch (e) {
        console.error('fetchExtLiveFiles error:', e);
    }
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

// =============================================================================
// UPLOAD STATION (Drag & Drop Direct Upload)
// =============================================================================

const uploadStationState = {
    phase: 'idle',           // idle | uploading | paused | completed | failed | stopped
    runId: null,
    current: 0,
    total: 0,
    uploaded: 0,
    failed: 0,
    skipped: 0,
    bytesDone: 0,
    bytesTotal: 0,
    speedMbps: null,
    currentFile: null
};

function initUploadStationDragAndDrop() {
    const dropZone = document.getElementById('drop-zone-large');
    if (!dropZone) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });

    // Window drag-over indication if on Upload Station view
    let dragCounter = 0;
    window.addEventListener('dragenter', (e) => {
        dragCounter++;
        const view = document.getElementById('view-upload');
        if (view && !view.classList.contains('hidden')) {
            dropZone.classList.add('dragover');
        }
    });

    window.addEventListener('dragleave', (e) => {
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            dropZone.classList.remove('dragover');
        }
    });

    window.addEventListener('drop', (e) => {
        dragCounter = 0;
        dropZone.classList.remove('dragover');
        const view = document.getElementById('view-upload');
        if (view && !view.classList.contains('hidden') && e.target !== dropZone && !dropZone.contains(e.target)) {
            handleDropEvent(e);
        }
    });

    dropZone.addEventListener('drop', handleDropEvent, false);
}

function triggerStationFileInput() {
    const input = document.getElementById('upload-station-file-input');
    if (input) input.click();
}

function handleStationFilesSelected(fileList) {
    if (!fileList || fileList.length === 0) return;
    uploadStationFiles(Array.from(fileList));
    const input = document.getElementById('upload-station-file-input');
    if (input) input.value = '';
}

async function handleDropEvent(e) {
    const items = e.dataTransfer.items;
    const files = [];

    if (items && items.length > 0) {
        const queue = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
            if (entry) {
                queue.push(traverseFileTree(entry));
            } else if (item.kind === 'file') {
                const f = item.getAsFile();
                if (f) files.push(f);
            }
        }
        if (queue.length > 0) {
            const nestedArrays = await Promise.all(queue);
            nestedArrays.forEach(arr => files.push(...arr));
        }
    } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
            files.push(e.dataTransfer.files[i]);
        }
    }

    if (files.length > 0) {
        uploadStationFiles(files);
    } else {
        showToast('No valid files detected in drop.', '⚠️');
    }
}

function traverseFileTree(item) {
    return new Promise((resolve) => {
        if (item.isFile) {
            item.file(file => resolve([file]), () => resolve([]));
        } else if (item.isDirectory) {
            const dirReader = item.createReader();
            const entriesList = [];
            const readEntries = () => {
                dirReader.readEntries(async (entries) => {
                    if (entries.length === 0) {
                        const results = await Promise.all(entriesList.map(e => traverseFileTree(e)));
                        resolve(results.flat());
                    } else {
                        entriesList.push(...entries);
                        readEntries();
                    }
                }, () => resolve([]));
            };
            readEntries();
        } else {
            resolve([]);
        }
    });
}

async function uploadStationFiles(files) {
    if (!files || files.length === 0) return;

    showToast(`Uploading ${files.length} file(s) to server…`, '☁️');
    setUploadStationPhaseBadge('Uploading', 'cyan');

    const list = document.getElementById('station-files-list');
    const emptyMsg = document.getElementById('station-files-empty');
    if (emptyMsg) emptyMsg.classList.add('hidden');

    files.forEach(f => {
        addOrUpdateStationFileRow(f.name, f.size, 'queued', 'Queued for upload');
    });

    const BATCH_SIZE = 15;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const formData = new FormData();
        batch.forEach(file => {
            formData.append('files', file, file.name);
        });

        try {
            const res = await fetch('/api/upload_station/upload', {
                method: 'POST',
                body: formData
            });
            const data = await res.json();
            if (data.status === 'queued') {
                // Successfully queued on server
            }
        } catch (err) {
            console.error('Upload station post error:', err);
            showToast(`Upload failed: ${err.message}`, '❌');
        }
    }
}

// ---------------------------------------------------------------------------
// Upload Station WS handlers
// ---------------------------------------------------------------------------

function onUploadStationRunStarted(data) {
    uploadStationState.phase = 'uploading';
    uploadStationState.runId = data.run_id;
    uploadStationState.total = data.total_files || 0;
    uploadStationState.bytesTotal = data.total_bytes || 0;
    uploadStationState.current = 0;
    uploadStationState.uploaded = 0;
    uploadStationState.failed = 0;
    uploadStationState.skipped = 0;
    uploadStationState.bytesDone = 0;
    uploadStationState.currentFile = null;
    uploadStationState.speedMbps = null;

    updateUploadStationUI();
    setUploadStationPhaseBadge('Uploading', 'cyan');
    setText('station-status-text', `Uploading batch of ${data.total_files} file(s) to Google Photos…`);
    showToast(`Upload Station session #${data.run_id} started.`, '🚀');
}

function onUploadStationFileStart(data) {
    uploadStationState.phase = 'uploading';
    uploadStationState.currentFile = data.filename;
    uploadStationState.current = data.current;
    uploadStationState.total = data.total || uploadStationState.total;

    updateUploadStationUI();
    addOrUpdateStationFileRow(data.filename, data.filesize, 'uploading', 'Streaming to Google Photos…');
}

function onUploadStationProgress(data) {
    uploadStationState.phase = 'uploading';
    uploadStationState.currentFile = data.filename;
    uploadStationState.current = data.current;
    uploadStationState.total = data.total;
    uploadStationState.uploaded = data.uploaded_files;
    uploadStationState.failed = data.failed_files;
    uploadStationState.bytesDone = data.cum_bytes;
    uploadStationState.bytesTotal = data.total_bytes;

    updateUploadStationUI();

    const activeBox = document.getElementById('station-active-file-box');
    if (activeBox) activeBox.classList.remove('hidden');
    setText('station-active-filename', data.filename || '—');
    setText('station-active-file-bytes', `${formatBytes(data.bytes_sent || 0)} / ${formatBytes(data.filesize || 0)}`);
    const filePct = data.filesize > 0 ? Math.min(100, (data.bytes_sent / data.filesize * 100)).toFixed(0) : 0;
    const fileBar = document.getElementById('station-active-file-bar');
    if (fileBar) fileBar.style.width = `${filePct}%`;

    updateStationFileProgress(data.filename, data.bytes_sent, data.filesize);
}

function onUploadStationSpeed(data) {
    uploadStationState.speedMbps = data.speed_mbps;
    if (data.speed_mbps !== null && data.speed_mbps !== undefined) {
        setText('station-upload-speed', `${data.speed_mbps.toFixed(2)} MB/s`);
        setText('station-active-file-speed', `${data.speed_mbps.toFixed(2)} MB/s`);
    }
}

function onUploadStationFileDone(data) {
    if (data.status === 'success' || data.status === 'duplicate') {
        uploadStationState.uploaded++;
    } else if (data.status === 'skipped') {
        uploadStationState.skipped++;
    }
    updateUploadStationUI();
    addOrUpdateStationFileRow(data.filename, data.filesize, data.status, data.status === 'duplicate' ? 'Already in Google Photos' : (data.error || 'Uploaded successfully'));
}

function onUploadStationFileFailed(data) {
    uploadStationState.failed++;
    updateUploadStationUI();
    addOrUpdateStationFileRow(data.filename, data.filesize, 'failed', data.error || 'Upload error');
}

function onUploadStationStopped(data) {
    uploadStationState.phase = 'stopped';
    setUploadStationPhaseBadge('Stopped', 'red');
    setText('station-status-text', 'Upload stopped by user.');
    updateUploadStationUI();
    fetchUploadStationHistory();
    showToast('Upload Station stopped.', '⏹️');
}

function onUploadStationCompleted(data) {
    const isError = data.status === 'failed';
    uploadStationState.phase = isError ? 'failed' : 'completed';
    setUploadStationPhaseBadge(isError ? 'Error' : 'Done', isError ? 'red' : 'green');
    setText('station-status-text', isError ? `Completed with errors: ${data.error || ''}` : `All ${data.total_files || 0} file(s) processed.`);
    
    const activeBox = document.getElementById('station-active-file-box');
    if (activeBox) activeBox.classList.add('hidden');

    updateUploadStationUI();
    fetchUploadStationHistory();
    fetchUploadStationLiveFiles();
    showToast(isError ? 'Upload finished with errors.' : 'All files uploaded to Google Photos!', isError ? '⚠️' : '✅');
}

function updateUploadStationUI() {
    const st = uploadStationState;
    const total = st.total || 0;
    const done = st.uploaded + st.failed + st.skipped;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

    setText('station-upload-pct-hero', `${pct}%`);
    setText('station-upload-count', `${done} / ${total} files`);
    
    if (st.speedMbps !== null && st.speedMbps !== undefined && st.phase === 'uploading') {
        setText('station-upload-speed', `${st.speedMbps.toFixed(2)} MB/s`);
    } else {
        setText('station-upload-speed', '— MB/s');
    }

    const segDone = document.getElementById('station-upload-seg-done');
    const segRem = document.getElementById('station-upload-seg-rem');
    if (segDone) segDone.style.width = `${pct}%`;
    if (segRem) segRem.style.width = `${100 - pct}%`;

    const isUploading = st.phase === 'uploading';
    const isPaused = st.phase === 'paused';
    const pauseBtn = document.getElementById('btn-station-pause-resume');
    const stopBtn = document.getElementById('btn-station-stop');
    const pauseText = document.getElementById('station-pause-text');

    if (pauseBtn) {
        if (isUploading || isPaused) {
            pauseBtn.classList.remove('hidden');
            if (isPaused) {
                pauseBtn.className = 'btn btn-success';
                if (pauseText) pauseText.innerHTML = '&#9654; Resume';
            } else {
                pauseBtn.className = 'btn';
                if (pauseText) pauseText.innerHTML = '&#9646;&#9646; Pause';
            }
        } else {
            pauseBtn.classList.add('hidden');
        }
    }

    if (stopBtn) {
        if (isUploading || isPaused) stopBtn.classList.remove('hidden');
        else stopBtn.classList.add('hidden');
    }

    const phaseTag = document.getElementById('station-upload-phase-tag');
    if (phaseTag) {
        const map = {
            idle: 'Ready',
            uploading: 'Uploading',
            paused: 'Paused',
            completed: 'Done',
            failed: 'Failed',
            stopped: 'Stopped'
        };
        phaseTag.textContent = map[st.phase] || st.phase;
    }
}

function setUploadStationPhaseBadge(text, color) {
    const badge = document.getElementById('station-upload-badge');
    if (!badge) return;
    badge.textContent = text;
    badge.className = `badge badge-${color}`;
}

async function uploadStationTogglePauseResume() {
    if (uploadStationState.phase === 'paused') {
        await fetch('/api/upload_station/resume', { method: 'POST' });
        uploadStationState.phase = 'uploading';
        setUploadStationPhaseBadge('Uploading', 'cyan');
        updateUploadStationUI();
        showToast('Upload resumed.', '▶️');
    } else {
        await fetch('/api/upload_station/pause', { method: 'POST' });
        uploadStationState.phase = 'paused';
        setUploadStationPhaseBadge('Paused', 'yellow');
        updateUploadStationUI();
        showToast('Upload paused.', '⏸️');
    }
}

async function uploadStationStopAction() {
    if (!confirm('Are you sure you want to stop the Upload Station process?')) return;
    await fetch('/api/upload_station/stop', { method: 'POST' });
    showToast('Stopping upload…', '⏹️');
}

function uploadStationClearQueue() {
    const list = document.getElementById('station-files-list');
    const emptyMsg = document.getElementById('station-files-empty');
    const countBadge = document.getElementById('station-feed-count');
    if (list) list.innerHTML = '';
    if (emptyMsg) emptyMsg.classList.remove('hidden');
    if (countBadge) countBadge.textContent = '0 files';
    showToast('Queue display cleared.', '🧹');
}

function addOrUpdateStationFileRow(filename, filesize, status, message) {
    const list = document.getElementById('station-files-list');
    const emptyMsg = document.getElementById('station-files-empty');
    const countBadge = document.getElementById('station-feed-count');
    if (!list) return;

    if (emptyMsg) emptyMsg.classList.add('hidden');

    const rowId = `station-file-${filename.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    let row = document.getElementById(rowId);

    const statusMap = {
        queued:    { text: 'Queued',    badgeClass: 'badge-gray',    liClass: '' },
        uploading: { text: 'Uploading', badgeClass: 'badge-purple',  liClass: 'file-item-uploading' },
        success:   { text: '✓ Done',    badgeClass: 'badge-green',   liClass: 'file-item-success' },
        duplicate: { text: '✓ In Cloud', badgeClass: 'badge-blue',   liClass: 'file-item-duplicate' },
        skipped:   { text: 'Skipped',   badgeClass: 'badge-gray',    liClass: 'file-item-skipped' },
        failed:    { text: '✕ Failed',  badgeClass: 'badge-red',     liClass: 'file-item-error' },
    };

    const s = statusMap[status] || statusMap.queued;

    if (!row) {
        row = document.createElement('li');
        row.id = rowId;
        row.className = `file-item ${s.liClass}`;
        list.insertBefore(row, list.firstChild);
    } else {
        row.className = `file-item ${s.liClass}`;
    }

    const sizeStr = filesize ? formatBytes(filesize) : '';

    row.innerHTML = `
        <div class="file-item-main">
            <div class="file-item-info">
                <span class="file-item-name" title="${escapeHtml(filename)}">${escapeHtml(filename)}</span>
                <span class="file-item-sub">${sizeStr ? sizeStr + ' &middot; ' : ''}${escapeHtml(message || '')}</span>
            </div>
            <span class="badge ${s.badgeClass}">${s.text}</span>
        </div>
    `;

    if (countBadge) countBadge.textContent = `${list.children.length} files`;
}

function updateStationFileProgress(filename, bytesSent, filesize) {
    const rowId = `station-file-${filename.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const row = document.getElementById(rowId);
    if (!row) return;

    const sub = row.querySelector('.file-item-sub');
    if (sub) {
        const pct = filesize > 0 ? Math.round((bytesSent / filesize) * 100) : 0;
        sub.innerHTML = `${formatBytes(bytesSent)} / ${formatBytes(filesize)} &middot; ${pct}%`;
    }
}

async function fetchUploadStationStatus() {
    try {
        const res = await fetch('/api/upload_station/status');
        const s = await res.json();
        uploadStationState.phase = s.phase;
        uploadStationState.runId = s.run_id;
        uploadStationState.current = s.current;
        uploadStationState.total = s.total;
        uploadStationState.uploaded = s.uploaded;
        uploadStationState.failed = s.failed;
        uploadStationState.skipped = s.skipped;
        uploadStationState.bytesDone = s.bytes_done;
        uploadStationState.bytesTotal = s.bytes_total;
        uploadStationState.speedMbps = s.speed_mbps;
        uploadStationState.currentFile = s.current_file;
        updateUploadStationUI();
    } catch (e) {
        console.error('fetchUploadStationStatus error:', e);
    }
}

async function fetchUploadStationLiveFiles() {
    try {
        const res = await fetch('/api/upload_station/live_files');
        const data = await res.json();
        const list = document.getElementById('station-files-list');
        const emptyMsg = document.getElementById('station-files-empty');
        const countBadge = document.getElementById('station-feed-count');
        if (!list) return;

        if (!data.files || data.files.length === 0) {
            if (emptyMsg) emptyMsg.classList.remove('hidden');
            if (countBadge) countBadge.textContent = '0 files';
            return;
        }

        if (emptyMsg) emptyMsg.classList.add('hidden');
        if (countBadge) countBadge.textContent = `${data.files.length} files`;

        list.innerHTML = '';
        data.files.forEach(f => {
            addOrUpdateStationFileRow(f.filename, f.filesize, f.upload_status, f.error_message || (f.upload_status === 'success' ? 'Uploaded OK' : ''));
        });
    } catch (e) {
        console.error('fetchUploadStationLiveFiles error:', e);
    }
}

async function fetchUploadStationHistory() {
    try {
        const res = await fetch('/api/upload_station/runs');
        const runs = await res.json();
        const tbody = document.getElementById('station-history-body');
        if (!tbody) return;

        if (!runs || runs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="history-empty">No upload sessions yet.</td></tr>';
            return;
        }

        tbody.innerHTML = runs.map((r, i) => {
            const statusBadge = r.overall_status === 'completed'
                ? '<span class="badge badge-green">Completed</span>'
                : r.overall_status === 'running'
                ? '<span class="badge badge-purple">Running</span>'
                : r.overall_status === 'stopped'
                ? '<span class="badge badge-yellow">Stopped</span>'
                : '<span class="badge badge-red">Failed</span>';

            const hasFailed = r.failed_files > 0;
            const reuploadBtn = hasFailed
                ? `<button onclick="uploadStationReupload(${r.id})" class="btn-xs" style="color:var(--red);border-color:var(--red);margin-right:4px;">↺ Re-upload Failed</button>`
                : '';

            return `
                <tr id="station-hist-row-${r.id}">
                    <td><strong>#${r.id}</strong></td>
                    <td>${formatDateTime(r.start_time)}</td>
                    <td>${r.total_files} files (${formatBytes(r.total_bytes || 0)})</td>
                    <td><span class="text-green" style="font-weight:700;">${r.uploaded_files}</span></td>
                    <td><span class="${r.failed_files > 0 ? 'text-red' : 'text-sub'}" style="font-weight:700;">${r.failed_files}</span></td>
                    <td><span class="text-sub">${r.skipped_files}</span></td>
                    <td>${statusBadge}</td>
                    <td style="text-align:right;">
                        <div style="display:flex;justify-content:flex-end;gap:4px;">
                            ${reuploadBtn}
                            <button onclick="viewUploadStationDetails(${r.id})" class="btn-xs">Details</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (e) {
        console.error('fetchUploadStationHistory error:', e);
    }
}

let _stationDetailsPanel = null;

async function viewUploadStationDetails(runId) {
    if (_stationDetailsPanel) {
        _stationDetailsPanel.remove();
        if (_stationDetailsPanel.dataset.runId == runId) {
            _stationDetailsPanel = null;
            return;
        }
        _stationDetailsPanel = null;
    }

    const tbody = document.getElementById('station-history-body');
    const anchorRow = document.getElementById(`station-hist-row-${runId}`);
    if (!anchorRow || !tbody) return;

    const panelRow = document.createElement('tr');
    panelRow.dataset.runId = String(runId);
    panelRow.innerHTML = `
        <td colspan="8" style="padding:0;background:var(--surface2);border-top:1px solid var(--border)">
            <div style="padding:14px">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                    <span style="font-size:12px;font-weight:700;color:var(--text)">Files &mdash; Session #${runId}</span>
                    <button onclick="this.closest('tr').remove(); _stationDetailsPanel = null;" class="btn-ghost-xs">&#10005; Close</button>
                </div>
                <div id="station-details-list-${runId}" style="max-height:220px;overflow-y:auto;">
                    <p style="color:var(--text-sub);font-size:11px;text-align:center;padding:12px">Loading files…</p>
                </div>
            </div>
        </td>
    `;
    _stationDetailsPanel = panelRow;
    anchorRow.insertAdjacentElement('afterend', panelRow);

    try {
        const res = await fetch(`/api/upload_station/runs/${runId}/files?limit=200`);
        const files = await res.json();
        const container = document.getElementById(`station-details-list-${runId}`);
        if (!container) return;

        if (!files || files.length === 0) {
            container.innerHTML = '<p style="color:var(--text-sub);font-size:11px;text-align:center;padding:12px">No files found for this session.</p>';
            return;
        }

        container.innerHTML = `
            <table class="history-table" style="font-size:11.5px;background:var(--surface);border-radius:4px;overflow:hidden;">
                <thead>
                    <tr>
                        <th>Filename</th>
                        <th>Size</th>
                        <th>Status</th>
                        <th>Duration / Error</th>
                    </tr>
                </thead>
                <tbody>
                    ${files.map(f => {
                        const statusBadge = f.upload_status === 'success' ? '<span class="badge badge-green">Uploaded</span>'
                            : f.upload_status === 'duplicate' ? '<span class="badge badge-blue">In Cloud</span>'
                            : f.upload_status === 'skipped' ? '<span class="badge badge-gray">Skipped</span>'
                            : '<span class="badge badge-red">Failed</span>';
                        return `
                            <tr>
                                <td style="font-family:monospace;font-weight:500;">${escapeHtml(f.filename)}</td>
                                <td>${formatBytes(f.filesize)}</td>
                                <td>${statusBadge}</td>
                                <td style="color:${f.error_message ? 'var(--red)' : 'var(--text-sub)'}">${f.error_message ? escapeHtml(f.error_message) : (f.duration_seconds ? f.duration_seconds + 's' : '—')}</td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        `;
    } catch (e) {
        console.error('viewUploadStationDetails error:', e);
    }
}

async function uploadStationReupload(runId) {
    try {
        const res = await fetch(`/api/upload_station/runs/${runId}/reupload`, { method: 'POST' });
        const data = await res.json();
        if (data.status === 'started') {
            showToast(`Re-uploading ${data.count} failed file(s)…`, '🚀');
            switchTab('upload');
        } else {
            showToast(data.message || 'Cannot re-upload: files already cleaned up or processed.', '⚠️');
        }
    } catch (e) {
        showToast(`Re-upload error: ${e.message}`, '❌');
    }
}

// =============================================================================
// Download Station & In-Page Browser
// =============================================================================

let downloadStationState = {
    phase: 'idle',           // idle | downloading | uploading | paused | completed | failed | stopped
    subphase: 'idle',        // downloading | uploading
    runId: null,
    current: 0,
    total: 0,
    downloaded: 0,
    uploaded: 0,
    failed: 0,
    skipped: 0,
    bytesDone: 0,
    bytesTotal: 0,
    speedMbps: null,
    currentFile: null,
    destDir: '/mnt/external_drive/Downloads'
};

// In-Page Browser Navigation History
let browserHistory = [];
let browserHistoryIndex = -1;
let currentBrowserUrl = 'https://drive.google.com';
let browserVncInitialized = false;

function initDownloadStationBrowser(targetUrl = 'https://drive.google.com') {
    const iframe = document.getElementById('browser-iframe');
    const vncUrl = `/novnc/vnc.html?autoconnect=true&resize=scale&reconnect=true&show_dot=true&path=websockify`;

    if (iframe) {
        if (!iframe.src || !iframe.src.includes('/novnc/')) {
            iframe.src = vncUrl;
            browserVncInitialized = true;
        }
        iframe.classList.remove('hidden');
    }
}

async function browserNavigateTo(url) {
    if (!url) return;
    url = url.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        if (url.includes('.') && !url.includes(' ')) {
            url = 'https://' + url;
        } else {
            url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
        }
    }

    currentBrowserUrl = url;
    initDownloadStationBrowser(url);

    try {
        await fetch('/api/download_station/browser/navigate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url })
        });
    } catch (e) {
        console.error('Browser navigation error:', e);
    }
}

function browserReload() {
    const iframe = document.getElementById('browser-iframe');
    if (iframe) {
        const vncUrl = `/novnc/vnc.html?autoconnect=true&resize=scale&reconnect=true&show_dot=true&path=websockify`;
        iframe.src = vncUrl + `&_t=${Date.now()}`;
    }
}

async function browserRestartService() {
    try {
        showToast('Restarting browser engine…', '⏳');
        const res = await fetch('/api/download_station/browser/restart', { method: 'POST' });
        const data = await res.json();
        showToast('Browser restarted', '✓');
        setTimeout(() => {
            browserReload();
        }, 1500);
    } catch (e) {
        showToast('Failed to restart browser: ' + e.message, '❌');
    }
}

function toggleBrowserFullscreen() {
    const container = document.getElementById('browser-viewport-container');
    if (container) {
        container.classList.toggle('browser-viewport-expanded');
    }
}

function submitDirectDownloadModal() {
    const rawVal = prompt('Enter Google Drive link, photo/video URL, or direct media download link:');
    if (!rawVal || !rawVal.trim()) return;
    const urls = rawVal.trim().split(/[\n,]+/).map(u => u.trim()).filter(u => u.length > 0);
    if (urls.length === 0) return;
    startDownloadStationPipeline(urls);
}

function submitDirectDownload() {
    const input = document.getElementById('direct-dl-url');
    if (!input || !input.value.trim()) {
        submitDirectDownloadModal();
        return;
    }
    const rawVal = input.value.trim();
    const urls = rawVal.split(/[\n,]+/).map(u => u.trim()).filter(u => u.length > 0);
    if (urls.length === 0) return;
    input.value = '';
    startDownloadStationPipeline(urls);
}

async function startDownloadStationPipeline(urls) {
    try {
        showToast(`Ingesting ${urls.length} download item(s)…`, '⏳');
        const res = await fetch('/api/download_station/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: urls })
        });
        const data = await res.json();
        if (data.status === 'queued') {
            showToast(`Downloading to External Drive: ${data.count} file(s)`, '🚀');
            downloadStationState.phase = 'downloading';
            downloadStationState.total = data.count;
            updateDownloadStationUI();
            fetchDownloadStationLiveFiles();
        } else {
            showToast(data.message || 'Download failed to start', '❌');
        }
    } catch (e) {
        showToast(`Download error: ${e.message}`, '❌');
    }
}

// ---------------------------------------------------------------------------
// Download Station WebSocket telemetry
// ---------------------------------------------------------------------------

function onDownloadStationRunStarted(data) {
    downloadStationState.phase = 'downloading';
    downloadStationState.subphase = 'downloading';
    downloadStationState.runId = data.run_id;
    downloadStationState.total = data.total_files || 1;
    downloadStationState.current = 0;
    downloadStationState.downloaded = 0;
    downloadStationState.uploaded = 0;
    downloadStationState.failed = 0;
    downloadStationState.skipped = 0;
    downloadStationState.bytesDone = 0;
    downloadStationState.bytesTotal = 0;
    downloadStationState.currentFile = null;
    downloadStationState.speedMbps = null;
    if (data.dest_dir) downloadStationState.destDir = data.dest_dir;
    updateDownloadStationUI();
    fetchDownloadStationLiveFiles();
    showToast('Download & Auto-Upload session started', '🚀');
}

function onDownloadStationFileStart(data) {
    downloadStationState.phase = 'downloading';
    downloadStationState.subphase = 'downloading';
    downloadStationState.current = data.current || 1;
    downloadStationState.total = data.total || downloadStationState.total;
    downloadStationState.currentFile = data.filename;
    updateDownloadStationUI();
    fetchDownloadStationLiveFiles();
}

function onDownloadStationDownloadProgress(data) {
    downloadStationState.phase = 'downloading';
    downloadStationState.subphase = 'downloading';
    downloadStationState.current = data.current || downloadStationState.current;
    downloadStationState.currentFile = data.filename;
    downloadStationState.bytesDone = data.bytes_downloaded || 0;
    downloadStationState.bytesTotal = data.total_bytes || 0;
    updateDownloadStationUI();
}

function onDownloadStationDownloadDone(data) {
    downloadStationState.downloaded = (downloadStationState.downloaded || 0) + 1;
    updateDownloadStationUI();
    fetchDownloadStationLiveFiles();
    showToast(`Saved to Ext Drive: ${data.filename}`, '💾');
}

function onDownloadStationUploadStart(data) {
    downloadStationState.phase = 'uploading';
    downloadStationState.subphase = 'uploading';
    downloadStationState.current = data.current || downloadStationState.current;
    downloadStationState.currentFile = data.filename;
    updateDownloadStationUI();
    fetchDownloadStationLiveFiles();
}

function onDownloadStationUploadProgress(data) {
    downloadStationState.phase = 'uploading';
    downloadStationState.subphase = 'uploading';
    downloadStationState.current = data.current || downloadStationState.current;
    downloadStationState.currentFile = data.filename;
    updateDownloadStationUI();
}

function onDownloadStationSpeed(data) {
    downloadStationState.speedMbps = data.speed_mbps;
    if (data.phase) downloadStationState.subphase = data.phase;
    updateDownloadStationUI();
}

function onDownloadStationFileDone(data) {
    downloadStationState.currentFile = null;
    if (data.status === 'success' || data.status === 'duplicate') {
        downloadStationState.uploaded = (downloadStationState.uploaded || 0) + 1;
    } else if (data.status === 'skipped') {
        downloadStationState.skipped = (downloadStationState.skipped || 0) + 1;
    }
    updateDownloadStationUI();
    fetchDownloadStationLiveFiles();
}

function onDownloadStationFileFailed(data) {
    downloadStationState.currentFile = null;
    downloadStationState.failed = (downloadStationState.failed || 0) + 1;
    updateDownloadStationUI();
    fetchDownloadStationLiveFiles();
}

function onDownloadStationStopped(data) {
    downloadStationState.phase = 'stopped';
    downloadStationState.currentFile = null;
    downloadStationState.speedMbps = null;
    updateDownloadStationUI();
    fetchDownloadStationLiveFiles();
    fetchDownloadStationHistory();
    showToast('Download Station stopped.', '⏹️');
}

function onDownloadStationCompleted(data) {
    downloadStationState.phase = data.status === 'completed' || data.status === 'partial_failure' ? 'completed' : 'failed';
    downloadStationState.currentFile = null;
    downloadStationState.speedMbps = null;
    if (data.downloaded_files !== undefined) downloadStationState.downloaded = data.downloaded_files;
    if (data.uploaded_files !== undefined) downloadStationState.uploaded = data.uploaded_files;
    if (data.failed_files !== undefined) downloadStationState.failed = data.failed_files;
    if (data.skipped_files !== undefined) downloadStationState.skipped = data.skipped_files;
    updateDownloadStationUI();
    fetchDownloadStationLiveFiles();
    fetchDownloadStationHistory();
    showToast(`Session finished (${data.status})`, data.status === 'completed' ? '🎉' : '⚠️');
}

// ---------------------------------------------------------------------------
// Download Station UI Updates
// ---------------------------------------------------------------------------

function updateDownloadStationUI() {
    const s = downloadStationState;
    const badge = document.getElementById('download-station-badge');
    const navBadge = document.getElementById('download-nav-badge');
    const btnPauseResume = document.getElementById('btn-download-pause-resume');
    const btnStop = document.getElementById('btn-download-stop');
    const dlPctHero = document.getElementById('download-pct-hero');
    const dlCount = document.getElementById('download-count');
    const dlSpeed = document.getElementById('download-speed');
    const dlSegDone = document.getElementById('download-seg-done');
    const dlSegRem = document.getElementById('download-seg-rem');
    const dlActiveBox = document.getElementById('download-active-file-box');
    const dlActiveName = document.getElementById('download-active-filename');
    const dlActiveBytes = document.getElementById('download-active-file-bytes');
    const dlActiveBar = document.getElementById('download-active-file-bar');
    const dlStatusText = document.getElementById('download-status-text');

    const upBadge = document.getElementById('download-upload-badge');
    const upPctHero = document.getElementById('download-upload-pct-hero');
    const upCount = document.getElementById('download-upload-count');
    const upSpeed = document.getElementById('download-upload-speed');
    const upSegDone = document.getElementById('download-upload-seg-done');
    const upSegRem = document.getElementById('download-upload-seg-rem');
    const upStatusText = document.getElementById('download-upload-status-text');

    // Download Percentage calculation
    const totalFiles = s.total || 0;
    const downloadedFiles = s.downloaded || 0;
    const uploadedFiles = s.uploaded || 0;

    let dlPct = totalFiles > 0 ? Math.round((downloadedFiles / totalFiles) * 100) : 0;
    if (s.phase === 'downloading' && s.bytesTotal > 0 && totalFiles > 0) {
        const filePct = s.bytesDone / s.bytesTotal;
        dlPct = Math.min(99, Math.round(((downloadedFiles + filePct) / totalFiles) * 100));
    } else if (s.phase === 'completed') {
        dlPct = 100;
    }

    let upPct = totalFiles > 0 ? Math.round((uploadedFiles / totalFiles) * 100) : 0;
    if (s.phase === 'completed') {
        upPct = totalFiles > 0 ? Math.round((uploadedFiles / totalFiles) * 100) : 100;
    }

    if (dlPctHero) dlPctHero.innerHTML = `${dlPct}<span class="stat-unit">%</span>`;
    if (dlCount) dlCount.textContent = `${downloadedFiles} / ${totalFiles} files saved`;
    if (dlSegDone) dlSegDone.style.width = `${dlPct}%`;
    if (dlSegRem) dlSegRem.style.width = `${100 - dlPct}%`;

    if (upPctHero) upPctHero.innerHTML = `${upPct}<span class="stat-unit">%</span>`;
    if (upCount) upCount.textContent = `${uploadedFiles} / ${totalFiles} files uploaded`;
    if (upSegDone) upSegDone.style.width = `${upPct}%`;
    if (upSegRem) upSegRem.style.width = `${100 - upPct}%`;

    // Speed display
    const speedStr = s.speedMbps !== null && s.speedMbps !== undefined ? `${Number(s.speedMbps).toFixed(2)} MB/s` : '— MB/s';
    if (s.subphase === 'downloading') {
        if (dlSpeed) dlSpeed.textContent = speedStr;
        if (upSpeed) upSpeed.textContent = '— MB/s';
    } else if (s.subphase === 'uploading') {
        if (dlSpeed) dlSpeed.textContent = 'Done';
        if (upSpeed) upSpeed.textContent = speedStr;
    } else {
        if (dlSpeed) dlSpeed.textContent = '— MB/s';
        if (upSpeed) upSpeed.textContent = '— MB/s';
    }

    // Active file progress
    if (s.currentFile && (s.phase === 'downloading' || s.phase === 'uploading')) {
        if (dlActiveBox) dlActiveBox.classList.remove('hidden');
        if (dlActiveName) dlActiveName.textContent = s.currentFile;
        if (s.bytesTotal > 0) {
            const pct = Math.round((s.bytesDone / s.bytesTotal) * 100);
            if (dlActiveBytes) dlActiveBytes.textContent = `${formatBytes(s.bytesDone)} / ${formatBytes(s.bytesTotal)} (${pct}%)`;
            if (dlActiveBar) dlActiveBar.style.width = `${pct}%`;
        } else {
            if (dlActiveBytes) dlActiveBytes.textContent = formatBytes(s.bytesDone);
            if (dlActiveBar) dlActiveBar.style.width = '50%';
        }
    } else {
        if (dlActiveBox) dlActiveBox.classList.add('hidden');
    }

    // Status badges & text
    if (badge) {
        badge.className = 'badge';
        if (s.phase === 'downloading') {
            badge.classList.add('badge-blue');
            badge.textContent = `Downloading (${s.current}/${s.total})`;
        } else if (s.phase === 'uploading') {
            badge.classList.add('badge-purple');
            badge.textContent = `Uploading (${s.current}/${s.total})`;
        } else if (s.phase === 'paused') {
            badge.classList.add('badge-yellow');
            badge.textContent = 'Paused';
        } else if (s.phase === 'completed') {
            badge.classList.add('badge-green');
            badge.textContent = 'Complete';
        } else if (s.phase === 'failed') {
            badge.classList.add('badge-red');
            badge.textContent = 'Error';
        } else if (s.phase === 'stopped') {
            badge.classList.add('badge-gray');
            badge.textContent = 'Stopped';
        } else {
            badge.classList.add('badge-gray');
            badge.textContent = 'Idle';
        }
    }

    if (navBadge) {
        if (s.phase === 'downloading' || s.phase === 'uploading') {
            navBadge.classList.remove('hidden');
            navBadge.textContent = s.phase === 'downloading' ? 'DL' : 'UP';
            navBadge.style.background = s.phase === 'downloading' ? 'var(--cyan)' : 'var(--purple)';
        } else {
            navBadge.classList.add('hidden');
        }
    }

    if (btnPauseResume && btnStop) {
        if (s.phase === 'downloading' || s.phase === 'uploading' || s.phase === 'paused') {
            btnPauseResume.classList.remove('hidden');
            btnStop.classList.remove('hidden');
            const pauseText = document.getElementById('download-pause-text');
            if (pauseText) pauseText.textContent = s.phase === 'paused' ? '▶ Resume' : '⏸ Pause';
        } else {
            btnPauseResume.classList.add('hidden');
            btnStop.classList.add('hidden');
        }
    }

    if (dlStatusText) {
        if (s.phase === 'downloading') dlStatusText.textContent = `Saving media to ${s.destDir}…`;
        else if (s.phase === 'uploading') dlStatusText.textContent = `Download finished. Streaming to Google Photos…`;
        else if (s.phase === 'completed') dlStatusText.textContent = `All files saved to ${s.destDir} and uploaded to Google Photos.`;
        else if (s.phase === 'paused') dlStatusText.textContent = 'Download station paused.';
        else dlStatusText.textContent = `Target directory: ${s.destDir}`;
    }

    if (upStatusText) {
        if (s.phase === 'uploading') upStatusText.textContent = `Uploading ${s.current}/${s.total}: ${s.currentFile || ''}`;
        else if (s.phase === 'completed') upStatusText.textContent = `Upload complete. Stored in Google Photos and External Drive.`;
        else upStatusText.textContent = 'Files are automatically uploaded to Google Photos once download finishes.';
    }
}

async function downloadStationTogglePauseResume() {
    try {
        if (downloadStationState.phase === 'paused') {
            await fetch('/api/download_station/resume', { method: 'POST' });
            downloadStationState.phase = downloadStationState.subphase || 'downloading';
            showToast('Download Station resumed', '▶️');
        } else {
            await fetch('/api/download_station/pause', { method: 'POST' });
            downloadStationState.phase = 'paused';
            showToast('Download Station paused', '⏸️');
        }
        updateDownloadStationUI();
    } catch (e) {
        showToast(`Control error: ${e.message}`, '❌');
    }
}

async function downloadStationStopAction() {
    try {
        await fetch('/api/download_station/stop', { method: 'POST' });
        downloadStationState.phase = 'stopped';
        updateDownloadStationUI();
        showToast('Stopping Download Station…', '⏹️');
    } catch (e) {
        showToast(`Stop error: ${e.message}`, '❌');
    }
}

// ---------------------------------------------------------------------------
// Download Station Live Queue & History Fetchers
// ---------------------------------------------------------------------------

async function fetchDownloadStationStatus() {
    try {
        const res = await fetch('/api/download_station/status');
        const data = await res.json();
        downloadStationState.phase = data.phase || 'idle';
        downloadStationState.subphase = data.subphase || 'idle';
        downloadStationState.runId = data.run_id;
        downloadStationState.current = data.current || 0;
        downloadStationState.total = data.total || 0;
        downloadStationState.downloaded = data.downloaded || 0;
        downloadStationState.uploaded = data.uploaded || 0;
        downloadStationState.failed = data.failed || 0;
        downloadStationState.skipped = data.skipped || 0;
        downloadStationState.bytesDone = data.bytes_done || 0;
        downloadStationState.bytesTotal = data.bytes_total || 0;
        downloadStationState.speedMbps = data.speed_mbps;
        downloadStationState.currentFile = data.current_file;
        if (data.dest_dir) downloadStationState.destDir = data.dest_dir;
        updateDownloadStationUI();
    } catch (e) {
        console.error('fetchDownloadStationStatus error:', e);
    }
}

async function fetchDownloadStationLiveFiles() {
    try {
        const res = await fetch('/api/download_station/live_files');
        const data = await res.json();
        renderDownloadStationLiveFiles(data.files || []);
    } catch (e) {
        console.error('fetchDownloadStationLiveFiles error:', e);
    }
}

function renderDownloadStationLiveFiles(files) {
    const list = document.getElementById('download-files-list');
    const empty = document.getElementById('download-files-empty');
    const countBadge = document.getElementById('download-feed-count');

    if (!list) return;
    if (countBadge) countBadge.textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;

    if (!files || files.length === 0) {
        list.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        return;
    }
    if (empty) empty.classList.add('hidden');

    list.innerHTML = files.map(f => {
        let statusBadge = '<span class="status-pill status-pill-pending">Downloading</span>';
        if (f.upload_status === 'success') {
            statusBadge = '<span class="status-pill status-pill-success">✓ Uploaded</span>';
        } else if (f.upload_status === 'duplicate') {
            statusBadge = '<span class="status-pill status-pill-duplicate">Duplicate</span>';
        } else if (f.upload_status === 'uploading') {
            statusBadge = '<span class="status-pill status-pill-uploading">Uploading</span>';
        } else if (f.download_status === 'downloaded' && f.upload_status === 'pending') {
            statusBadge = '<span class="status-pill status-pill-amber">Downloaded</span>';
        } else if (f.download_status === 'failed' || f.upload_status === 'failed') {
            statusBadge = `<span class="status-pill status-pill-failed" title="${escapeHtml(f.error_message || '')}">✗ Failed</span>`;
        }

        const sizeStr = f.filesize ? formatBytes(f.filesize) : '';
        const durStr = f.upload_duration ? `${f.upload_duration}s` : (f.download_duration ? `${f.download_duration}s dl` : '');

        return `
            <li class="file-item">
                <div class="file-item-left">
                    <div class="file-type-icon">📥</div>
                    <div class="file-info-text">
                        <span class="file-name" title="${escapeHtml(f.filename)}">${escapeHtml(f.filename)}</span>
                        <span class="file-meta">${sizeStr ? sizeStr + ' · ' : ''}${escapeHtml(f.source_url || '')}</span>
                    </div>
                </div>
                <div class="file-item-right">
                    ${durStr ? `<span class="file-duration">${durStr}</span>` : ''}
                    ${statusBadge}
                </div>
            </li>
        `;
    }).join('');
}

async function fetchDownloadStationHistory() {
    try {
        const res = await fetch('/api/download_station/runs');
        const runs = await res.json();
        renderDownloadStationHistory(runs || []);
    } catch (e) {
        console.error('fetchDownloadStationHistory error:', e);
    }
}

function renderDownloadStationHistory(runs) {
    const tbody = document.getElementById('download-history-body');
    if (!tbody) return;

    if (!runs || runs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="history-empty">No download sessions yet.</td></tr>';
        return;
    }

    tbody.innerHTML = runs.map(r => {
        let statusBadge = `<span class="status-pill status-pill-${r.overall_status}">${r.overall_status}</span>`;
        const timeStr = r.start_time ? formatRelativeTime(r.start_time) : '—';
        const sourceUrlTrunc = r.source_url ? (r.source_url.length > 35 ? r.source_url.slice(0, 35) + '…' : r.source_url) : 'web_browser';

        return `
            <tr class="history-row" onclick="viewDownloadStationDetails(${r.id}, event)">
                <td class="cell-id">#${r.id}</td>
                <td><span class="history-time">${timeStr}</span></td>
                <td><span class="url-snippet" title="${escapeHtml(r.source_url || '')}">${escapeHtml(sourceUrlTrunc)}</span></td>
                <td>${r.total_files || 0}</td>
                <td class="text-cyan">${r.downloaded_files || 0}</td>
                <td class="text-green">${r.uploaded_files || 0}</td>
                <td class="${r.failed_files > 0 ? 'text-red' : ''}">${r.failed_files || 0}</td>
                <td>${statusBadge}</td>
                <td style="text-align:right;">
                    ${r.failed_files > 0 ? `<button onclick="retryDownloadRun(${r.id}); event.stopPropagation();" class="btn-xs" style="background:var(--red-soft);color:var(--red);border-color:var(--red);">Retry</button>` : ''}
                </td>
            </tr>
            <tr id="download-details-${r.id}" class="history-details-row hidden">
                <td colspan="9" id="download-details-content-${r.id}" class="history-details-cell">
                    <div class="history-loading">Loading files…</div>
                </td>
            </tr>
        `;
    }).join('');
}

async function viewDownloadStationDetails(runId, event) {
    const row = document.getElementById(`download-details-${runId}`);
    const content = document.getElementById(`download-details-content-${runId}`);
    if (!row || !content) return;

    if (!row.classList.contains('hidden')) {
        row.classList.add('hidden');
        return;
    }

    row.classList.remove('hidden');
    content.innerHTML = '<div class="history-loading">Loading file records…</div>';

    try {
        const res = await fetch(`/api/download_station/runs/${runId}/files?limit=200`);
        const files = await res.json();

        if (!files || files.length === 0) {
            content.innerHTML = '<p class="file-empty" style="padding:12px;">No file records found for this session.</p>';
            return;
        }

        content.innerHTML = `
            <table class="nested-files-table">
                <thead>
                    <tr>
                        <th>Filename</th>
                        <th>Path on Ext Drive</th>
                        <th>Size</th>
                        <th>Download Status</th>
                        <th>Upload Status</th>
                        <th>Error / Duration</th>
                    </tr>
                </thead>
                <tbody>
                    ${files.map(f => {
                        return `
                            <tr>
                                <td class="cell-filename">${escapeHtml(f.filename || '—')}</td>
                                <td class="cell-path" title="${escapeHtml(f.filepath || '')}">${escapeHtml(f.filepath || '—')}</td>
                                <td>${f.filesize ? formatBytes(f.filesize) : '—'}</td>
                                <td><span class="status-pill status-pill-${f.download_status}">${f.download_status}</span></td>
                                <td><span class="status-pill status-pill-${f.upload_status}">${f.upload_status}</span></td>
                                <td style="color:${f.error_message ? 'var(--red)' : 'var(--text-sub)'}">${f.error_message ? escapeHtml(f.error_message) : (f.upload_duration ? f.upload_duration + 's' : '—')}</td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        `;
    } catch (e) {
        console.error('viewDownloadStationDetails error:', e);
    }
}

async function retryDownloadRun(runId) {
    try {
        const res = await fetch(`/api/download_station/runs/${runId}/retry`, { method: 'POST' });
        const data = await res.json();
        if (data.status === 'started') {
            showToast(`Retrying ${data.count} failed item(s)…`, '🚀');
            switchTab('download');
        } else {
            showToast(data.message || 'Cannot retry.', '⚠️');
        }
    } catch (e) {
        showToast(`Retry error: ${e.message}`, '❌');
    }
}

// ---------------------------------------------------------------------------
// PWA Installation & Service Worker
// ---------------------------------------------------------------------------
let _deferredPwaPrompt = null;

function initPwa() {
    // 1. Register Service Worker
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js', { scope: '/' })
                .then(reg => {
                    console.log('[PWA] Service Worker registered with scope:', reg.scope);
                })
                .catch(err => {
                    console.warn('[PWA] Service Worker registration failed:', err);
                });
        });
    }

    // 2. Capture beforeinstallprompt (Chrome / Edge / Android)
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        _deferredPwaPrompt = e;
        console.log('[PWA] beforeinstallprompt captured');

        // Show install button in sidebar
        const btnSidebar = document.getElementById('btn-pwa-install');
        if (btnSidebar) btnSidebar.classList.remove('hidden');

        const btnSettings = document.getElementById('btn-pwa-install-settings');
        if (btnSettings) {
            btnSettings.textContent = '⚡ Install Media Hub App';
        }
    });

    // 3. Listen for appinstalled
    window.addEventListener('appinstalled', () => {
        console.log('[PWA] App installed successfully');
        _deferredPwaPrompt = null;
        const btnSidebar = document.getElementById('btn-pwa-install');
        if (btnSidebar) btnSidebar.classList.add('hidden');
        showToast('Media Hub installed successfully!', '🎉');
    });

    // 4. Standalone display mode check
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (isStandalone) {
        document.body.classList.add('is-pwa-standalone');
        const btnSidebar = document.getElementById('btn-pwa-install');
        if (btnSidebar) btnSidebar.classList.add('hidden');
    }
}

async function triggerPwaInstall() {
    if (_deferredPwaPrompt) {
        _deferredPwaPrompt.prompt();
        const { outcome } = await _deferredPwaPrompt.userChoice;
        console.log('[PWA] User choice outcome:', outcome);
        if (outcome === 'accepted') {
            showToast('Installing Media Hub…', '🚀');
        }
        _deferredPwaPrompt = null;
    } else {
        // Fallback for browsers that don't emit beforeinstallprompt (Safari iOS / Mac Safari)
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        const isMacSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        if (isIOS) {
            alert('To install on iPhone/iPad:\n1. Tap the Share button (⬆️) at the bottom.\n2. Scroll down and tap "Add to Home Screen" (+).');
        } else if (isMacSafari) {
            alert('To install on Mac Safari:\n1. Click "File" in the top macOS menu bar.\n2. Click "Add to Dock…".');
        } else {
            showToast('To install: click the Install icon in your browser address bar (top right).', 'ℹ️');
        }
    }
}

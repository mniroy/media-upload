// =============================================================================
// Media Upload Hub — app.js
// =============================================================================

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
let currentDevice = null;          // current USB device name
let pendingRunId = null;           // run_id waiting for folder selection
let pendingFolders = [];           // folders returned by copy_done_select
let countdownTimer = null;         // folder-modal auto-upload countdown
let speedSamples = [];             // rolling speed history (MB/s) for smoothing
const MAX_SPEED_SAMPLES = 5;

// ---------------------------------------------------------------------------
// DOMContentLoaded boot
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    // Navigation
    const tabs = ['live', 'files', 'history', 'settings', 'extdrive'];
    tabs.forEach(tab => {
        document.getElementById(`tab-${tab}`).addEventListener('click', (e) => {
            document.querySelectorAll('.view-section').forEach(el => {
                el.classList.add('hidden');
                el.classList.remove('block');
            });
            document.getElementById(`view-${tab}`).classList.remove('hidden');
            document.getElementById(`view-${tab}`).classList.add('block');

            document.querySelectorAll('.nav-item').forEach(el => {
                el.classList.remove('bg-blue-50', 'text-blue-700', 'bg-amber-50', 'text-amber-700');
                el.classList.add('text-gray-600');
            });
            e.currentTarget.classList.remove('text-gray-600');
            if (tab === 'extdrive') {
                e.currentTarget.classList.add('bg-amber-50', 'text-amber-700');
            } else {
                e.currentTarget.classList.add('bg-blue-50', 'text-blue-700');
            }

            if (tab === 'history') fetchHistory();
            if (tab === 'files') fetchFiles();
            if (tab === 'extdrive') { fetchExtDriveStatus(); fetchExtDriveHistory(); }
        });
    });

    // Initial data (settings + storage always; dashboard hydrated via state_sync)
    fetchStorage();
    fetchSettings();

    // WebSocket \u2014 state_sync on connect will hydrate the dashboard
    connectWebSocket();

    // Page Visibility API: re-sync state when tab becomes visible again
    // (covers mobile safari background, OS sleep, tab switching)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            // If WS is still connected, server already pushed any in-flight events.
            // Fetch REST state as a safety net in case WS missed events while hidden.
            fetch('/api/state')
                .then(r => r.json())
                .then(s => onStateSync(s))
                .catch(() => {});
            fetchStorage();
        }
    });

    // Modal buttons
    document.getElementById('modal-upload-all').addEventListener('click', () => {
        clearCountdown();
        closeModal();
        const allFolderNames = pendingFolders.map(f => f.name);
        if (pendingRunId !== null) {
            // USB run: upload via run_id + folder list
            startUploadSelected(pendingRunId, allFolderNames);
        } else {
            // Manual staging: trigger per-folder local uploads
            startStagingUpload(allFolderNames);
        }
    });

    document.getElementById('modal-upload-selected').addEventListener('click', () => {
        clearCountdown();
        closeModal();
        const checked = [...document.querySelectorAll('#folder-list input[type=checkbox]:checked')];
        const selected = checked.map(cb => cb.dataset.folder);
        if (selected.length === 0) {
            showToast('No folders selected \u2014 upload skipped.', '\u26a0\ufe0f');
            return;
        }
        if (pendingRunId !== null) {
            startUploadSelected(pendingRunId, selected);
        } else {
            startStagingUpload(selected);
        }
    });

    document.getElementById('modal-cancel').addEventListener('click', () => {
        clearCountdown();
        closeModal();
        showToast('Upload skipped.', 'ℹ️');
    });

    // Settings save
    document.getElementById('save-settings-btn').addEventListener('click', saveSettings);
});


// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
let _wsConnected = false;

function connectWebSocket() {
    const ws = new WebSocket(`ws://${location.host}/ws`);

    ws.onopen = () => {
        _wsConnected = true;
    };

    ws.onmessage = handleWsMessage;

    ws.onclose = () => {
        _wsConnected = false;
        // Reconnect after 3 s — on reconnect the server will push state_sync
        setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
        // Let onclose handle the reconnect
    };
}

function handleWsMessage(event) {
    const payload = JSON.parse(event.data);
    const data = payload.data;

    switch (payload.event) {
        case 'state_sync':
            onStateSync(data);
            break;
        case 'auto_copy_toggled':
            updateAutoCopyBadges(data.enabled);
            break;
        case 'run_started':
            onRunStarted(data);
            break;
        case 'usb_info':
            onUsbInfo(data);
            break;
        case 'copy_progress':
            onCopyProgress(data);
            break;
        case 'copy_stopped':
            onCopyStopped(data);
            break;
        case 'copy_done':
            onCopyDone();
            break;
        case 'copy_done_select':
            onCopyDoneSelect(data);
            break;
        case 'upload_started':
            onUploadStarted(data);
            break;
        case 'upload_progress':
            onUploadProgress(data);
            break;
        case 'upload_speed':
            onUploadSpeed(data);
            break;
        case 'upload_stopped':
            onUploadStopped(data);
            break;
        case 'upload_done':
            onUploadDone(data);
            break;
        case 'run_completed':
            onRunCompleted(data);
            break;
        // --- External Drive events (separate workflow) ---
        case 'ext_run_started':
            onExtRunStarted(data);
            break;
        case 'ext_scan_started':
            onExtScanStarted(data);
            break;
        case 'ext_scan_done':
            onExtScanDone(data);
            break;
        case 'ext_upload_started':
            onExtUploadStarted(data);
            break;
        case 'ext_upload_progress':
            onExtUploadProgress(data);
            break;
        case 'ext_upload_speed':
            onExtUploadSpeed(data);
            break;
        case 'ext_upload_stopped':
            onExtUploadStopped(data);
            break;
        case 'ext_upload_done':
            onExtUploadDone(data);
            break;
        case 'ext_run_completed':
            onExtRunCompleted(data);
            break;
    }
}

// ---------------------------------------------------------------------------
// state_sync — restore full UI state for any client that connects/refreshes
// ---------------------------------------------------------------------------

function onStateSync(s) {
    // s is the _live_state object from the server
    const phase = s.phase || 'idle';
    currentDevice = s.device;
    
    // Update auto-copy badges
    updateAutoCopyBadges(s.auto_copy_enabled);

    // Always restore USB info bar if we have it
    if (s.usb_info && s.device && s.device !== 'local_disk') {
        onUsbInfo({ device: s.device, ...s.usb_info });
    }

    // Restore copy ring
    if (s.copy_total > 0) {
        updateRing('copy', s.copy_current, s.copy_total);
    }

    // Restore upload ring
    if (s.upload_total > 0) {
        updateRing('upload', s.upload_current, s.upload_total);
    }

    // Restore speed
    if (s.speed_mbps !== null && s.speed_mbps !== undefined) {
        setSpeed(s.speed_mbps.toFixed(2));
    } else {
        setSpeed('—');
    }

    // Restore status text and badges based on phase
    switch (phase) {
        case 'copying':
            document.getElementById('local-status').textContent =
                s.current_file ? `Copying: ${s.current_file}` : `Copying from USB ${s.device}…`;
            document.getElementById('cloud-status').textContent = 'Waiting for local copy…';
            setBadge('copy', 'Copying');
            setBadge('upload', 'Waiting', 'gray');
            showCopyControls(true);
            break;

        case 'copy_paused':
            document.getElementById('local-status').textContent = 'Copy paused — click Resume to continue.';
            setBadge('copy', 'Paused', 'yellow');
            showCopyControls(true);
            // Show resume button, hide pause button
            document.getElementById('btn-copy-pause').classList.add('hidden');
            document.getElementById('btn-copy-resume').classList.remove('hidden');
            break;

        case 'copy_done':
            document.getElementById('local-status').textContent = 'Local copy complete.';
            setBadge('copy', 'Done', 'green');
            document.getElementById('cloud-status').textContent = 'Waiting to upload…';
            showCopyControls(false);
            break;

        case 'copy_done_select':
            document.getElementById('local-status').textContent = 'Local copy complete.';
            setBadge('copy', 'Done', 'green');
            document.getElementById('cloud-status').textContent = 'Waiting for folder selection…';
            showCopyControls(false);
            // Re-open the folder selection modal for this client
            // The countdown starts fresh for each client — that's intentional.
            // The original client's countdown is still running on the server.
            if (s.folders && s.folders.length > 0) {
                pendingRunId = s.run_id;
                pendingFolders = s.folders;
                openFolderModal(s.folders, s.auto_upload_seconds || 30);
            }
            break;

        case 'uploading':
            document.getElementById('local-status').textContent =
                s.copy_total > 0 ? `Copy complete — ${s.copy_current}/${s.copy_total} files` : 'Local files ready.';
            document.getElementById('cloud-status').textContent =
                s.current_file ? `Uploading: ${s.current_file}` : 'Uploading to Google Photos…';
            setBadge('copy', 'Done', 'green');
            setBadge('upload', 'Uploading', 'purple');
            document.getElementById('upload-controls').classList.remove('hidden');
            if (s.copy_total > 0) {
                const ring = document.getElementById('copy-ring');
                if (ring) ring.style.strokeDashoffset = 0;
                document.getElementById('copy-pct').textContent = '100%';
            }
            break;

        case 'upload_paused':
            document.getElementById('cloud-status').textContent = 'Upload paused.';
            setBadge('upload', 'Paused', 'yellow');
            break;

        case 'upload_done':
        case 'completed':
            document.getElementById('local-status').textContent =
                s.copy_total > 0 ? `Complete — ${s.copy_current}/${s.copy_total} files from ${s.device || ''}` : 'Complete.';
            document.getElementById('cloud-status').textContent =
                s.upload_total > 0 ? `Complete — ${s.upload_current}/${s.upload_total} files uploaded` : 'Upload complete.';
            setBadge('copy', 'Done', 'green');
            setBadge('upload', 'Done', 'green');
            document.getElementById('upload-controls').classList.add('hidden');
            if (s.upload_total > 0) {
                updateRing('upload', s.upload_total, s.upload_total);
            }
            break;

        case 'failed':
            document.getElementById('local-status').textContent =
                `Error: ${s.error || 'Unknown error'}`;
            setBadge('copy', 'Failed', 'red');
            break;

        case 'idle':
        default:
            // Nothing running — fetchActiveDashboard will handle hydration from DB
            break;
    }

    // Always also call fetchActiveDashboard to populate file lists from DB
    // (don't re-call if a live process is actively running — would flash)
    if (phase === 'idle' || phase === 'completed' || phase === 'failed') {
        fetchActiveDashboard();
    }

    // Restore ext drive state
    const extPhase = s.ext_phase || 'idle';
    extState.phase = extPhase;
    extState.runId = s.ext_run_id;
    extState.current = s.ext_upload_current || 0;
    extState.total = s.ext_upload_total || 0;
    extState.speedMbps = s.ext_speed_mbps;

    if (s.ext_upload_total > 0) {
        updateExtRing(s.ext_upload_current || 0, s.ext_upload_total);
    }
    if (s.ext_speed_mbps !== null && s.ext_speed_mbps !== undefined) {
        setExtSpeed(s.ext_speed_mbps.toFixed(2));
    }

    switch (extPhase) {
        case 'scanning':
            setExtPhaseBadge('Scanning', 'amber');
            setExtStatusText(`Counting files on drive… ${s.ext_upload_total > 0 ? s.ext_upload_total + ' found' : ''}`);
            showExtControls(true, false);
            break;
        case 'uploading':
            setExtPhaseBadge('Uploading', 'amber');
            setExtStatusText(s.ext_current_file ? `Uploading: ${s.ext_current_file}` : 'Uploading to Google Photos…');
            showExtControls(true, false);
            break;
        case 'upload_paused':
            setExtPhaseBadge('Paused', 'yellow');
            setExtStatusText('Upload paused.');
            showExtControls(true, true);
            break;
        case 'upload_done':
        case 'completed':
            setExtPhaseBadge('Done', 'green');
            setExtStatusText(`Complete — ${s.ext_upload_current}/${s.ext_upload_total} files uploaded.`);
            showExtControls(false, false);
            if (s.ext_upload_total > 0) updateExtRing(s.ext_upload_total, s.ext_upload_total);
            break;
        case 'failed':
            setExtPhaseBadge('Error', 'red');
            setExtStatusText(`Error: ${s.ext_error || 'Unknown error'}`);
            showExtControls(false, false);
            break;
        case 'idle':
        default:
            break;
    }
}

// ---------------------------------------------------------------------------
// WS event handlers
// ---------------------------------------------------------------------------

function onRunStarted(data) {
    currentDevice = data.device;
    document.getElementById('local-status').textContent =
        data.device === 'local_disk' ? 'Uploading from staging directory...' : `Copying from USB ${data.device}...`;
    document.getElementById('cloud-status').textContent = 'Waiting for local copy...';
    document.getElementById('local-files').innerHTML = '';
    document.getElementById('cloud-files').innerHTML = '';
    setBadge('copy', data.device === 'local_disk' ? 'Uploading' : 'Copying');
    setBadge('upload', 'Waiting');
    updateRing('copy', 0, 0);
    updateRing('upload', 0, 0);
    speedSamples = [];
    setSpeed('—');
    showCopyControls(true);
}

function onUsbInfo(data) {
    const bar = document.getElementById('usb-info-bar');
    bar.classList.remove('hidden');
    document.getElementById('usb-info-device').textContent = `USB: /dev/${data.device}`;
    document.getElementById('usb-total').textContent = formatBytes(data.total);
    document.getElementById('usb-used').textContent = formatBytes(data.used);
    document.getElementById('usb-free').textContent = formatBytes(data.free);
    const pct = data.total > 0 ? (data.used / data.total * 100).toFixed(1) : 0;
    document.getElementById('usb-bar').style.width = pct + '%';
    document.getElementById('usb-mount-badge').textContent = data.mounted ? 'Mounted' : 'Unmounted';
    document.getElementById('usb-mount-badge').className = data.mounted
        ? 'px-2 py-0.5 bg-green-100 text-green-700 rounded-full'
        : 'px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full';

    // Store device for unmount button
    document.getElementById('btn-unmount').dataset.device = data.device;
}

function onCopyProgress(data) {
    document.getElementById('local-status').textContent = `Copying: ${data.filename}`;
    updateRing('copy', data.current - 1, data.total);
    addFileRow('local-files', data.filename, 'copying');
}

function onCopyStopped(data) {
    document.getElementById('local-status').textContent = `Copy stopped at ${data.at} / ${data.total} files.`;
    setBadge('copy', 'Stopped', 'red');
    showCopyControls(false);
}

function onCopyDone() {
    document.getElementById('local-status').textContent = 'Local copy complete.';
    setBadge('copy', 'Done', 'green');
    showCopyControls(false);
    // Ring filled to 100%
    const ring = document.getElementById('copy-ring');
    if (ring) ring.style.strokeDashoffset = 0;
    document.getElementById('copy-pct').textContent = '100%';
}

function onCopyDoneSelect(data) {
    // Auto upload after copy — show folder selection modal
    pendingRunId = data.run_id;
    pendingFolders = data.folders || [];
    openFolderModal(pendingFolders, data.auto_upload_seconds || 30);
}

function onUploadStarted(data) {
    setBadge('upload', 'Uploading');
    document.getElementById('cloud-status').textContent = 'Uploading to Google Photos...';
    document.getElementById('upload-controls').classList.remove('hidden');
    speedSamples = [];
    setSpeed('—');
}

function onUploadProgress(data) {
    const status = data.status || 'uploading';
    const filename = data.filename;

    if (status === 'uploading') {
        document.getElementById('cloud-status').textContent = `Checking: ${filename}`;
        setSpeed('...', true);
    } else if (status === 'uploaded') {
        document.getElementById('cloud-status').textContent = `Uploaded: ${filename}`;
    } else if (status === 'already_in_photos') {
        document.getElementById('cloud-status').textContent = `Already in Photos: ${filename}`;
        setSpeed('—');
    } else if (status === 'skipped') {
        document.getElementById('cloud-status').textContent = `Skipped: ${filename}`;
        setSpeed('—');
    } else if (status === 'failed') {
        document.getElementById('cloud-status').textContent = `⚠️ Failed: ${filename}`;
        setSpeed('—');
    }

    updateRing('upload', data.current, data.total);
    addFileRow('cloud-files', filename, status);
}

function onUploadSpeed(data) {
    const mbps = data.speed_mbps;
    if (mbps === null || mbps === undefined) {
        // File was skipped / already in photos — don't update rolling avg
        return;
    }
    // Rolling average for actual uploads
    speedSamples.push(mbps);
    if (speedSamples.length > MAX_SPEED_SAMPLES) speedSamples.shift();
    const avg = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
    setSpeed(avg.toFixed(2));
}

function onUploadStopped(data) {
    document.getElementById('cloud-status').textContent = `Upload stopped at ${data.at} / ${data.total} files.`;
    setBadge('upload', 'Stopped', 'red');
    document.getElementById('upload-controls').classList.add('hidden');
    setSpeed('—');
}

function onUploadDone(data) {
    document.getElementById('cloud-status').textContent = 'Upload complete.';
    setBadge('upload', 'Done', 'green');
    document.getElementById('upload-controls').classList.add('hidden');
    setSpeed('—');
    speedSamples = [];
    // Mark any file still showing "Uploading" as uploaded (edge case)
    document.querySelectorAll('#cloud-files [data-file]').forEach(el => {
        const chip = el.querySelector('.status-chip');
        if (chip && chip.textContent.includes('Uploading')) {
            chip.innerHTML = statusChip('uploaded');
        }
    });
    fetchStorage();
}

function onRunCompleted(data) {
    fetchStorage();
    fetchActiveDashboard();
}

// ---------------------------------------------------------------------------
// Folder Selection Modal
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
            div.className = 'flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors';
            div.innerHTML = `
                <input type="checkbox" checked data-folder="${escapeAttr(f.name)}"
                    class="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500">
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium text-gray-800 truncate">${escapeHtml(f.name)}</p>
                    <p class="text-xs text-gray-500">${f.type === 'folder' ? `${f.file_count} files` : 'file'} · ${formatBytes(f.size)}</p>
                </div>
                <span class="text-xs px-2 py-0.5 rounded-full ${f.type === 'folder' ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-500'}">
                    ${f.type === 'folder' ? '📁' : '📄'}
                </span>
            `;
            list.appendChild(div);
        });
    }

    modal.classList.remove('hidden');
    startCountdown(autoSeconds);
}

function closeModal() {
    document.getElementById('folder-modal').classList.add('hidden');
}

function startCountdown(seconds) {
    const totalSeconds = seconds;
    let remaining = totalSeconds;
    const label = document.getElementById('countdown-label');
    const secEl = document.getElementById('countdown-sec');
    const ring = document.getElementById('countdown-ring');
    const circumference = 125.66; // 2*pi*20

    const tick = () => {
        label.textContent = remaining;
        secEl.textContent = remaining;
        const offset = circumference * (1 - remaining / totalSeconds);
        ring.style.strokeDashoffset = offset;

        if (remaining <= 0) {
            clearInterval(countdownTimer);
            countdownTimer = null;
            closeModal();
            // Auto-upload all
            if (pendingRunId !== null && pendingFolders.length > 0) {
                startUploadSelected(pendingRunId, pendingFolders.map(f => f.name));
            }
            return;
        }
        remaining--;
    };

    tick();
    countdownTimer = setInterval(tick, 1000);
}

function clearCountdown() {
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
}

async function startUploadSelected(runId, folders) {
    try {
        const res = await fetch('/api/upload_selected', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ run_id: runId, folders })
        });
        if (res.ok) {
            showToast(`Uploading ${folders.length} folder(s)…`, '☁️');
            setBadge('upload', 'Uploading');
            document.getElementById('upload-controls').classList.remove('hidden');
        } else {
            showToast('Failed to start upload.', '✕');
        }
    } catch (e) {
        console.error(e);
        showToast('Error starting upload.', '✕');
    }
}

async function startStagingUpload(folders) {
    // For manual staging uploads: call trigger_local_upload for each selected folder
    try {
        let started = 0;
        for (const folder of folders) {
            const res = await fetch('/api/trigger_local_upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder })
            });
            if (res.ok) started++;
        }
        if (started > 0) {
            showToast(`Uploading ${started} folder(s) from staging…`, '☁️');
            setBadge('upload', 'Uploading');
            document.getElementById('upload-controls').classList.remove('hidden');
        } else {
            showToast('Failed to start upload.', '✕');
        }
    } catch (e) {
        console.error(e);
        showToast('Error starting upload.', '✕');
    }
}

// ---------------------------------------------------------------------------
// Copy / Upload controls
// ---------------------------------------------------------------------------

function showCopyControls(show) {
    const el = document.getElementById('copy-controls');
    if (show) {
        el.classList.remove('hidden');
        el.classList.add('flex');
    } else {
        el.classList.add('hidden');
        el.classList.remove('flex');
    }
}

async function copyPause() {
    await fetch('/api/copy/pause', { method: 'POST' });
    document.getElementById('btn-copy-pause').classList.add('hidden');
    document.getElementById('btn-copy-resume').classList.remove('hidden');
    setBadge('copy', 'Paused', 'yellow');
    document.getElementById('local-status').textContent = 'Copy paused — click Resume to continue.';
}

async function copyResume() {
    await fetch('/api/copy/resume', { method: 'POST' });
    document.getElementById('btn-copy-pause').classList.remove('hidden');
    document.getElementById('btn-copy-resume').classList.add('hidden');
    setBadge('copy', 'Copying');
}

async function copyStop() {
    await fetch('/api/copy/stop', { method: 'POST' });
    showCopyControls(false);
}

async function uploadStop() {
    await fetch('/api/upload/stop', { method: 'POST' });
    document.getElementById('upload-controls').classList.add('hidden');
}

async function unmountUSB() {
    const device = document.getElementById('btn-unmount').dataset.device || currentDevice;
    if (!device) return;
    try {
        const res = await fetch(`/api/usb/${device}/unmount`, { method: 'POST' });
        if (res.ok) {
            document.getElementById('usb-mount-badge').textContent = 'Unmounted';
            document.getElementById('usb-mount-badge').className = 'px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full';
            document.getElementById('btn-unmount').disabled = true;
            showToast('USB unmounted safely.', '✓');
        }
    } catch (e) {
        showToast('Failed to unmount USB.', '✕');
    }
}

// ---------------------------------------------------------------------------
// Ring chart helpers
// ---------------------------------------------------------------------------

function updateRing(type, done, total) {
    const circumference = 314;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const offset = circumference - (pct / 100) * circumference;
    const ring = document.getElementById(`${type}-ring`);
    const pctEl = document.getElementById(`${type}-pct`);
    const countEl = document.getElementById(`${type}-count`);
    if (ring) ring.style.strokeDashoffset = offset;
    if (pctEl) pctEl.textContent = pct + '%';
    if (countEl) countEl.textContent = `${done} / ${total} files`;
}

function setBadge(type, label, color = 'default') {
    const el = document.getElementById(`${type}-badge`);
    if (!el) return;
    const colorMap = {
        default: 'px-2.5 py-1 bg-blue-100 text-blue-700 text-xs font-semibold rounded-full',
        green: 'px-2.5 py-1 bg-green-100 text-green-700 text-xs font-semibold rounded-full',
        red: 'px-2.5 py-1 bg-red-100 text-red-700 text-xs font-semibold rounded-full',
        yellow: 'px-2.5 py-1 bg-yellow-100 text-yellow-800 text-xs font-semibold rounded-full',
        gray: 'px-2.5 py-1 bg-gray-100 text-gray-500 text-xs font-semibold rounded-full',
        purple: 'px-2.5 py-1 bg-purple-100 text-purple-700 text-xs font-semibold rounded-full',
    };
    el.className = colorMap[color] || colorMap.default;
    el.textContent = label;
}

function setSpeed(value, loading = false) {
    const el = document.getElementById('upload-speed');
    if (!el) return;
    el.textContent = loading ? '... MB/s' : (value === '—' ? '— MB/s' : `${value} MB/s`);
}

function updateAutoCopyBadges(enabled) {
    const sidebarBadge = document.getElementById('sidebar-service-badge');
    const dashBadge = document.getElementById('dashboard-service-badge');
    const toggleBtn = document.getElementById('btn-toggle-service');
    
    if (enabled) {
        if (sidebarBadge) {
            sidebarBadge.textContent = 'Active';
            sidebarBadge.className = 'px-2 py-0.5 bg-green-100 text-green-700 text-xs font-bold rounded-full';
        }
        if (dashBadge) {
            dashBadge.textContent = 'Auto-Copy Active';
            dashBadge.className = 'px-2 py-1 bg-green-100 text-green-700 text-xs font-bold rounded-full';
        }
        if (toggleBtn) {
            toggleBtn.textContent = 'Stop Service';
            toggleBtn.className = 'bg-yellow-500 hover:bg-yellow-600 text-white font-semibold py-2 px-4 rounded-lg transition-colors text-sm shadow-sm';
        }
    } else {
        if (sidebarBadge) {
            sidebarBadge.textContent = 'Suspended';
            sidebarBadge.className = 'px-2 py-0.5 bg-yellow-100 text-yellow-800 text-xs font-bold rounded-full';
        }
        if (dashBadge) {
            dashBadge.textContent = 'Auto-Copy Suspended';
            dashBadge.className = 'px-2 py-1 bg-yellow-100 text-yellow-800 text-xs font-bold rounded-full';
        }
        if (toggleBtn) {
            toggleBtn.textContent = 'Start Service';
            toggleBtn.className = 'bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors text-sm shadow-sm';
        }
    }
}

// ---------------------------------------------------------------------------
// File row helpers
// ---------------------------------------------------------------------------

function fileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const isVideo = ['mp4', 'mov', 'avi', 'mkv', 'dng'].includes(ext);
    if (isVideo) {
        return `<div class="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
            <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        </div>`;
    }
    return `<div class="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center flex-shrink-0">
        <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
    </div>`;
}

function statusChip(status) {
    const map = {
        copied:           '<span class="text-xs font-medium text-green-600">(Copied)</span>',
        copying:          '<span class="text-xs font-medium text-blue-500 pulse-dot">(Copying…)</span>',
        uploading:        '<span class="text-xs font-medium text-purple-400 pulse-dot">(Checking…)</span>',
        uploaded:         '<span class="text-xs font-medium text-green-600">✓ Uploaded</span>',
        already_in_photos:'<span class="text-xs font-medium text-sky-500">☁ Already in Photos</span>',
        skipped:          '<span class="text-xs font-medium text-amber-500">— Skipped (non-media)</span>',
        failed:           '<span class="text-xs font-medium text-red-500">⚠ Failed</span>',
    };
    return map[status] || '<span class="text-xs font-medium text-gray-400">(Queued)</span>';
}

function addFileRow(listId, filename, status) {
    const list = document.getElementById(listId);
    if (!list) return;
    const existing = list.querySelector(`[data-file="${CSS.escape(filename)}"]`);
    if (existing) {
        existing.querySelector('.status-chip').innerHTML = statusChip(status);
        return;
    }
    const li = document.createElement('li');
    li.setAttribute('data-file', filename);
    li.className = 'flex items-center gap-2 py-1.5 border-b border-gray-50 last:border-0 file-row-new';
    const name = filename.split('/').pop();
    li.innerHTML = `
        ${fileIcon(filename)}
        <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-gray-700 truncate">${escapeHtml(name)}</p>
            <span class="status-chip">${statusChip(status)}</span>
        </div>
    `;
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

        // Checkboxes: treat missing value as default (true for these three)
        document.getElementById('recursive').checked   = data['RECURSIVE']      !== 'false';
        document.getElementById('auto-album').checked  = data['AUTO_ALBUM']     !== 'false';
        document.getElementById('skip-existing').checked = data['SKIP_EXISTING'] !== 'false';
        // delete-upload defaults to off
        document.getElementById('delete-upload').checked = data['DELETE_UPLOAD'] === 'true';
    } catch (e) {
        console.error('Failed to load settings', e);
    }
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
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings })
        });
        if (res.ok) {
            showToast('Settings saved ✓', '✓');
        } else {
            showToast('Failed to save settings.', '✕');
        }
    } catch (e) {
        console.error('Failed to save settings', e);
        showToast('Error saving settings.', '✕');
    }
}

// ---------------------------------------------------------------------------
// Storage widget
// ---------------------------------------------------------------------------

async function fetchStorage() {
    try {
        const res = await fetch('/api/system/storage');
        const data = await res.json();
        document.getElementById('storage-used').textContent = formatBytes(data.used);
        document.getElementById('storage-free').textContent = formatBytes(data.free) + ' free';
        document.getElementById('storage-total').textContent = formatBytes(data.total) + ' total';
        const percent = data.total > 0 ? (data.used / data.total) * 100 : 0;
        document.getElementById('storage-bar').style.width = percent + '%';
    } catch (e) {
        console.error('Failed to fetch storage', e);
    }
}

// ---------------------------------------------------------------------------
// Dashboard hydration from DB (on load / run_completed)
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
            document.getElementById('local-status').textContent = isCopying
                ? `Copying from ${latest.usb_identifier}… (${latest.copied_files}/${latest.total_files} files)`
                : `Copy complete — ${latest.copied_files}/${latest.total_files} files`;
            document.getElementById('cloud-status').textContent = isCopying
                ? 'Waiting for copy to complete…'
                : `Uploading to Google Photos… (${latest.uploaded_files}/${latest.total_files} files)`;
            setBadge('copy', isCopying ? 'Copying' : 'Done', isCopying ? 'default' : 'green');
            setBadge('upload', isCopying ? 'Waiting' : 'Uploading', isCopying ? 'gray' : 'purple');
        } else if (latest.overall_status === 'completed') {
            document.getElementById('local-status').textContent =
                `Complete — ${latest.copied_files}/${latest.total_files} files from ${latest.usb_identifier}`;
            document.getElementById('cloud-status').textContent =
                `Complete — ${latest.uploaded_files}/${latest.total_files} files uploaded`;
            setBadge('copy', 'Done', 'green');
            setBadge('upload', 'Done', 'green');
        } else if (latest.overall_status === 'failed') {
            document.getElementById('local-status').textContent =
                `Last run failed for device ${latest.usb_identifier}`;
            setBadge('copy', 'Failed', 'red');
        }

        // Hydrate file lists
        const detailRes = await fetch(`/api/runs/${latest.id}`);
        const files = await detailRes.json();
        document.getElementById('local-files').innerHTML = '';
        document.getElementById('cloud-files').innerHTML = '';
        files.slice().reverse().forEach((f, idx) => {
            let copyStatus = f.copy_status === 'success' ? 'copied'
                : f.copy_status === 'pending' && idx === 0 ? 'copying' : 'queued';
            addFileRow('local-files', f.filename, copyStatus);
            if (f.copy_status === 'success' || f.upload_status !== 'pending') {
                let uploadStatus = 'queued';
                if (f.upload_status === 'success') {
                    uploadStatus = f.error_message === 'already_in_photos' ? 'already_in_photos' : 'uploaded';
                } else if (f.upload_status === 'skipped') {
                    uploadStatus = 'skipped';
                } else if (f.upload_status === 'failed') {
                    uploadStatus = 'failed';
                }
                addFileRow('cloud-files', f.filename, uploadStatus);
            }
        });
    } catch (e) {
        console.error('Failed to fetch active dashboard', e);
    }
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
        runs.forEach(run => {
            const tr = document.createElement('tr');
            const statusColor = run.overall_status === 'completed'
                ? 'bg-green-100 text-green-800'
                : run.overall_status === 'failed'
                    ? 'bg-red-100 text-red-700'
                    : 'bg-yellow-100 text-yellow-800';
            tr.innerHTML = `
                <td class="p-4">${run.id}</td>
                <td class="p-4 font-medium text-gray-900">${escapeHtml(run.usb_identifier)}</td>
                <td class="p-4 text-gray-500">${formatDateTime(run.start_time)}</td>
                <td class="p-4 font-semibold text-blue-600">${run.copied_files} / ${run.total_files}</td>
                <td class="p-4 font-semibold text-purple-600">${run.uploaded_files} / ${run.total_files}</td>
                <td class="p-4">
                    <span class="px-2 py-1 text-xs font-semibold rounded-full ${statusColor}">
                        ${run.overall_status}
                    </span>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) {
        console.error('Failed to fetch history', e);
    }
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
        tbody.innerHTML = `<tr><td colspan="2" class="p-8 text-center text-gray-500">No files in staging directory.</td></tr>`;
        return;
    }

    files.forEach(file => {
        const tr = document.createElement('tr');
        if (file.type === 'directory') {
            const newPath = file.name === '..'
                ? path.split('/').slice(0, -1).join('/')
                : (path ? path + '/' + file.name : file.name);
            tr.innerHTML = `
                <td class="p-4 font-medium text-blue-600 flex items-center cursor-pointer hover:underline" onclick="fetchFiles('${escapeAttr(newPath)}')">
                    <svg class="w-4 h-4 mr-2 text-blue-400" fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"></path></svg>
                    ${escapeHtml(file.name)}
                </td>
                <td class="p-4 text-gray-500">—</td>
            `;
        } else {
            tr.innerHTML = `
                <td class="p-4 font-medium text-gray-900 flex items-center">
                    <svg class="w-4 h-4 mr-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                    ${escapeHtml(file.name)}
                </td>
                <td class="p-4 text-gray-500">${formatBytes(file.size)}</td>
            `;
        }
        tbody.appendChild(tr);
    });
}

// ---------------------------------------------------------------------------
// Manual upload trigger (button in dashboard header)
// ---------------------------------------------------------------------------

async function triggerLocalUpload() {
    // Fetch staging folders with real size info from /api/staging/folders
    try {
        const res = await fetch('/api/staging/folders');
        const folders = await res.json();

        if (folders.length === 0) {
            // No sub-folders; just trigger upload of everything
            const r = await fetch('/api/trigger_local_upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            if (r.ok) showToast('Uploading staged files…', '☁️');
            else showToast('Failed to start upload.', '✕');
            return;
        }

        // Show folder modal — pendingRunId=null means use trigger_local_upload
        pendingRunId = null;
        pendingFolders = folders;
        openFolderModal(folders, 30);
    } catch (e) {
        console.error(e);
        showToast('Error fetching staged files.', '✕');
    }
}

// ---------------------------------------------------------------------------
// Toast notification
// ---------------------------------------------------------------------------

let toastTimer = null;

function showToast(message, icon = '✓') {
    const toast = document.getElementById('toast');
    document.getElementById('toast-msg').textContent = message;
    document.getElementById('toast-icon').textContent = icon;
    toast.classList.remove('hide');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hide'), 3000);
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatDateTime(isoStr) {
    if (!isoStr) return '—';
    // Server stores UTC but omits the Z suffix — add it so the browser
    // correctly converts to local timezone instead of treating it as local time.
    const utc = isoStr.endsWith('Z') || isoStr.includes('+') ? isoStr : isoStr + 'Z';
    const d = new Date(utc);
    if (isNaN(d)) return isoStr;
    return d.toLocaleString();
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// System Controls
// ---------------------------------------------------------------------------

async function systemToggleService() {
    const btn = document.getElementById('btn-toggle-service');
    const isStopping = btn && btn.textContent.trim() === 'Stop Service';
    const endpoint = isStopping ? '/api/system/stop' : '/api/system/start';
    
    try {
        await fetch(endpoint, { method: 'POST' });
        showToast(isStopping ? 'Auto-copy service suspended' : 'Auto-copy service started', isStopping ? '⏸️' : '▶️');
        // updateAutoCopyBadges will be called via WS broadcast automatically
    } catch (e) {
        showToast('Failed to toggle service.', '✕');
    }
}

async function systemRestart() {
    if (!confirm('Are you sure you want to restart the system? Any ongoing transfers will be aborted.')) return;
    try {
        await fetch('/api/system/restart', { method: 'POST' });
        showToast('System is restarting...', '🔄');
    } catch (e) {
        showToast('Failed to restart system.', '✕');
    }
}

async function systemShutdown() {
    if (!confirm('Are you sure you want to shut down the system? Any ongoing transfers will be aborted.')) return;
    try {
        await fetch('/api/system/shutdown', { method: 'POST' });
        showToast('System is shutting down...', '🔌');
    } catch (e) {
        showToast('Failed to shut down system.', '✕');
    }
}

// =============================================================================
// EXTERNAL DRIVE — completely separate from USB copy+upload workflow
// =============================================================================

// ---------------------------------------------------------------------------
// Ext drive state object
// ---------------------------------------------------------------------------
const extState = {
    phase: 'idle',       // idle | scanning | uploading | upload_paused | upload_done | completed | failed
    runId: null,
    current: 0,
    total: 0,
    speedMbps: null,
};
let extSpeedSamples = [];

// ---------------------------------------------------------------------------
// WS event handlers — ext_ prefixed
// ---------------------------------------------------------------------------

function onExtRunStarted(data) {
    extState.phase = 'scanning';
    extState.runId = data.run_id;
    extState.current = 0;
    extState.total = 0;
    extSpeedSamples = [];
    setExtPhaseBadge('Scanning…', 'amber');
    setExtStatusText('Scanning external drive for media files…');
    showExtControls(true, false);
    setExtNavBadge(true);
    updateExtRing(0, 0);
    document.getElementById('ext-files').innerHTML = '';
    const emptyMsg = document.getElementById('ext-files-empty');
    if (emptyMsg) emptyMsg.classList.remove('hidden');
    // Show the in-progress session in history immediately
    fetchExtDriveHistory();
}

function onExtScanStarted(data) {
    setExtStatusText('Counting media files on the drive…');
}

function onExtScanDone(data) {
    extState.total = data.total || 0;
    setExtStatusText(`Found ${extState.total.toLocaleString()} media files. Starting upload…`);
    updateExtRing(0, extState.total);
}

function onExtUploadStarted(data) {
    extState.phase = 'uploading';
    extState.total = data.total || 0;
    setExtPhaseBadge('Uploading', 'amber');
    setExtStatusText('Uploading to Google Photos…');
    showExtControls(true, false);
    updateExtRing(0, extState.total);
}

function onExtUploadProgress(data) {
    const status = data.status || 'uploading';
    const filename = data.filename || (data.filepath || '').split('/').pop();
    extState.current = data.current || 0;
    extState.total = data.total || extState.total;

    updateExtRing(extState.current, extState.total);

    const statusMsgMap = {
        uploading:               `Uploading: ${filename}`,
        uploaded:                `✓ Uploaded: ${filename}`,
        already_in_photos:       `☁ Already in Photos: ${filename}`,
        skipped:                 `— Skipped: ${filename}`,
        skipped_already_uploaded:`— Previously uploaded: ${filename}`,
        failed:                  `⚠ Failed: ${filename}`,
    };
    setExtStatusText(statusMsgMap[status] || `Processing: ${filename}`);

    if (status !== 'uploading' && status !== 'skipped_already_uploaded') {
        addExtFileRow(filename, data.filepath || filename, status);
    }
}

function onExtUploadSpeed(data) {
    const mbps = data.speed_mbps;
    if (mbps === null || mbps === undefined) return;
    extSpeedSamples.push(mbps);
    if (extSpeedSamples.length > 5) extSpeedSamples.shift();
    const avg = extSpeedSamples.reduce((a, b) => a + b, 0) / extSpeedSamples.length;
    setExtSpeed(avg.toFixed(2));
    extState.speedMbps = avg;
}

function onExtUploadStopped(data) {
    extState.phase = 'upload_paused';
    setExtPhaseBadge('Paused', 'yellow');
    setExtStatusText(`Upload paused at ${data.at} / ${data.total} files. Click Resume to continue.`);
    showExtControls(true, true); // show resume, hide pause
}

function onExtUploadDone(data) {
    extState.phase = 'upload_done';
    const { uploaded = 0, failed = 0, skipped = 0, total = extState.total } = data;
    setExtPhaseBadge('Done', 'green');
    setExtStatusText(`Complete — ${uploaded.toLocaleString()} uploaded, ${skipped} skipped, ${failed} failed.`);
    showExtControls(false, false);
    setExtSpeed('—');
    extSpeedSamples = [];
    updateExtRing(total, total);
}

function onExtRunCompleted(data) {
    if (data.error) {
        extState.phase = 'failed';
        setExtPhaseBadge('Error', 'red');
        setExtStatusText(`Error: ${data.error}`);
        showExtControls(false, false);
        setExtNavBadge(false);
    } else {
        extState.phase = 'completed';
        setExtNavBadge(false);
        fetchExtDriveHistory();
    }
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

async function extStartUpload() {
    const phase = extState.phase;
    if (phase === 'scanning' || phase === 'uploading') {
        showToast('Upload already in progress.', 'ℹ️');
        return;
    }
    try {
        const res = await fetch('/api/extdrive/upload', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'already_running') {
            showToast('Already running — check the Ext Drive tab.', 'ℹ️');
        } else {
            showToast('External drive upload started.', '💾');
        }
    } catch (e) {
        showToast('Failed to start ext drive upload.', '✕');
    }
}

async function extStop() {
    await fetch('/api/extdrive/stop', { method: 'POST' });
    showToast('Stopping ext drive upload…', '⏹️');
}

async function extPause() {
    await fetch('/api/extdrive/pause', { method: 'POST' });
    document.getElementById('btn-ext-pause').classList.add('hidden');
    document.getElementById('btn-ext-resume').classList.remove('hidden');
    setExtPhaseBadge('Paused', 'yellow');
    setExtStatusText('Upload paused — click Resume to continue.');
}

async function extResume() {
    await fetch('/api/extdrive/resume', { method: 'POST' });
    document.getElementById('btn-ext-pause').classList.remove('hidden');
    document.getElementById('btn-ext-resume').classList.add('hidden');
    setExtPhaseBadge('Uploading', 'amber');
}

async function fetchExtDriveStatus() {
    try {
        const res = await fetch('/api/extdrive/status');
        const data = await res.json();
        const badge = document.getElementById('ext-mount-badge');
        const mp = document.getElementById('ext-mount-point');
        if (badge) {
            badge.textContent = data.mounted ? 'Mounted' : 'Not Mounted';
            badge.className = data.mounted
                ? 'ml-auto px-2.5 py-1 bg-green-100 text-green-700 text-xs font-semibold rounded-full'
                : 'ml-auto px-2.5 py-1 bg-red-100 text-red-700 text-xs font-semibold rounded-full';
        }
        if (mp) mp.textContent = data.mount_point || '/mnt/external_drive';
        if (data.mounted && data.total > 0) {
            const t = document.getElementById('ext-total');
            const u = document.getElementById('ext-used');
            const f = document.getElementById('ext-free');
            const bar = document.getElementById('ext-drive-bar');
            if (t) t.textContent = formatBytes(data.total);
            if (u) u.textContent = formatBytes(data.used);
            if (f) f.textContent = formatBytes(data.free);
            const pct = (data.used / data.total * 100).toFixed(1);
            if (bar) bar.style.width = pct + '%';
        }
    } catch (e) {
        console.error('Failed to fetch ext drive status', e);
    }
}

async function fetchExtDriveHistory() {
    try {
        const res = await fetch('/api/extdrive/runs');
        const runs = await res.json();
        const tbody = document.getElementById('ext-history-body');
        if (!tbody) return;
        if (!runs || runs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-gray-400">No sessions yet.</td></tr>';
            return;
        }
        tbody.innerHTML = '';
        runs.forEach(run => {
            const statusColor = run.overall_status === 'completed'
                ? 'bg-green-100 text-green-800'
                : run.overall_status === 'completed_with_errors'
                    ? 'bg-yellow-100 text-yellow-800'
                    : run.overall_status === 'stopped' || run.overall_status === 'interrupted'
                        ? 'bg-gray-100 text-gray-600'
                        : run.overall_status === 'failed'
                            ? 'bg-red-100 text-red-700'
                            : run.overall_status === 'running'
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-gray-100 text-gray-400';
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="p-4 text-gray-500">#${run.id}</td>
                <td class="p-4 text-gray-600">${formatDateTime(run.start_time)}</td>
                <td class="p-4 font-semibold text-gray-700">${(run.total_files || 0).toLocaleString()}</td>
                <td class="p-4 font-semibold text-green-700">${(run.uploaded_files || 0).toLocaleString()}</td>
                <td class="p-4 font-semibold text-red-600">${(run.failed_files || 0).toLocaleString()}</td>
                <td class="p-4 font-semibold text-gray-500">${(run.skipped_files || 0).toLocaleString()}</td>
                <td class="p-4">
                    <span class="px-2 py-1 text-xs font-semibold rounded-full ${statusColor}">
                        ${run.overall_status}
                    </span>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) {
        console.error('Failed to fetch ext drive history', e);
    }
}

// ---------------------------------------------------------------------------
// Ext drive UI helpers
// ---------------------------------------------------------------------------

function updateExtRing(done, total) {
    const circumference = 314;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const offset = circumference - (pct / 100) * circumference;
    const ring = document.getElementById('ext-ring');
    const pctEl = document.getElementById('ext-pct');
    const countEl = document.getElementById('ext-count');
    if (ring) ring.style.strokeDashoffset = offset;
    if (pctEl) pctEl.textContent = pct + '%';
    if (countEl) countEl.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} files`;
}

function setExtPhaseBadge(label, color = 'gray') {
    const el = document.getElementById('ext-phase-badge');
    if (!el) return;
    const colorMap = {
        amber:  'px-2.5 py-1 bg-amber-100 text-amber-700 text-xs font-semibold rounded-full',
        green:  'px-2.5 py-1 bg-green-100 text-green-700 text-xs font-semibold rounded-full',
        red:    'px-2.5 py-1 bg-red-100 text-red-700 text-xs font-semibold rounded-full',
        yellow: 'px-2.5 py-1 bg-yellow-100 text-yellow-800 text-xs font-semibold rounded-full',
        gray:   'px-2.5 py-1 bg-gray-100 text-gray-500 text-xs font-semibold rounded-full',
    };
    el.className = colorMap[color] || colorMap.gray;
    el.textContent = label;
}

function setExtStatusText(text) {
    const el = document.getElementById('ext-status-text');
    if (el) el.textContent = text;
}

function setExtSpeed(value) {
    const el = document.getElementById('ext-speed');
    if (!el) return;
    el.textContent = (value === '—' || !value) ? '— MB/s' : `${value} MB/s`;
}

function setExtNavBadge(active) {
    const badge = document.getElementById('ext-nav-badge');
    if (!badge) return;
    if (active) {
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

/**
 * Show/hide ext drive control buttons.
 * @param {boolean} active   - true = upload is running or paused
 * @param {boolean} paused   - true = currently paused (show Resume, hide Pause)
 */
function showExtControls(active, paused) {
    const uploadBtn  = document.getElementById('btn-ext-upload');
    const pauseBtn   = document.getElementById('btn-ext-pause');
    const resumeBtn  = document.getElementById('btn-ext-resume');
    const stopBtn    = document.getElementById('btn-ext-stop');

    if (active) {
        if (uploadBtn)  uploadBtn.classList.add('hidden');
        if (stopBtn)    stopBtn.classList.remove('hidden');
        if (paused) {
            if (pauseBtn)   pauseBtn.classList.add('hidden');
            if (resumeBtn)  resumeBtn.classList.remove('hidden');
        } else {
            if (pauseBtn)   pauseBtn.classList.remove('hidden');
            if (resumeBtn)  resumeBtn.classList.add('hidden');
        }
    } else {
        if (uploadBtn)  uploadBtn.classList.remove('hidden');
        if (pauseBtn)   pauseBtn.classList.add('hidden');
        if (resumeBtn)  resumeBtn.classList.add('hidden');
        if (stopBtn)    stopBtn.classList.add('hidden');
    }
}

function addExtFileRow(filename, fullpath, status) {
    const list = document.getElementById('ext-files');
    if (!list) return;

    const emptyMsg = document.getElementById('ext-files-empty');
    if (emptyMsg) emptyMsg.classList.add('hidden');

    // Update existing row if present
    const key = CSS.escape(fullpath || filename);
    const existing = list.querySelector(`[data-file="${key}"]`);
    if (existing) {
        const chip = existing.querySelector('.ext-status-chip');
        if (chip) chip.innerHTML = extStatusChip(status);
        return;
    }

    const li = document.createElement('li');
    li.setAttribute('data-file', fullpath || filename);
    li.className = 'flex items-center gap-2 py-1.5 border-b border-gray-50 last:border-0 file-row-new';
    li.innerHTML = `
        ${fileIcon(filename)}
        <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-gray-700 truncate">${escapeHtml(filename)}</p>
            <span class="ext-status-chip">${extStatusChip(status)}</span>
        </div>
    `;
    list.insertBefore(li, list.firstChild);

    // Cap list at 60 rows to avoid DOM bloat
    while (list.children.length > 60) {
        list.removeChild(list.lastChild);
    }
}

function extStatusChip(status) {
    const map = {
        uploading:               '<span class="text-xs font-medium text-amber-500 pulse-dot">(Uploading…)</span>',
        uploaded:                '<span class="text-xs font-medium text-green-600">✓ Uploaded</span>',
        already_in_photos:       '<span class="text-xs font-medium text-sky-500">☁ Already in Photos</span>',
        skipped:                 '<span class="text-xs font-medium text-gray-400">— Skipped</span>',
        skipped_already_uploaded:'<span class="text-xs font-medium text-gray-400">— Previously uploaded</span>',
        failed:                  '<span class="text-xs font-medium text-red-500">⚠ Failed</span>',
    };
    return map[status] || '<span class="text-xs font-medium text-gray-400">(Queued)</span>';
}


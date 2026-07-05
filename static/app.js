document.addEventListener('DOMContentLoaded', () => {
    // Navigation
    const tabs = ['live', 'files', 'history', 'settings'];
    tabs.forEach(tab => {
        document.getElementById(`tab-${tab}`).addEventListener('click', (e) => {
            // Hide all views
            document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
            document.querySelectorAll('.view-section').forEach(el => el.classList.remove('block'));
            
            // Show target view
            document.getElementById(`view-${tab}`).classList.remove('hidden');
            document.getElementById(`view-${tab}`).classList.add('block');
            
            // Update active state on sidebar items
            document.querySelectorAll('.nav-item').forEach(el => {
                el.classList.remove('bg-blue-50', 'text-blue-700');
                el.classList.add('text-gray-600');
            });
            e.currentTarget.classList.remove('text-gray-600');
            e.currentTarget.classList.add('bg-blue-50', 'text-blue-700');

            // Load data if needed
            if (tab === 'history') fetchHistory();
            if (tab === 'files') fetchFiles();
        });
    });

    // Fetch initial data
    fetchStorage();
    fetchSettings();
    fetchActiveDashboard();

    // WebSocket
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = function(event) {
        const payload = JSON.parse(event.data);
        const data = payload.data;

        if (payload.event === "run_started") {
            // Reset both panels
            document.getElementById('local-status').textContent = `Copying from USB ${data.device}...`;
            document.getElementById('cloud-status').textContent = 'Waiting for local copy...';
            document.getElementById('local-files').innerHTML = '';
            document.getElementById('cloud-files').innerHTML = '';
            document.getElementById('copy-badge').textContent = 'Copying';
            document.getElementById('copy-badge').className = 'px-2.5 py-1 bg-blue-100 text-blue-700 text-xs font-semibold rounded-full';
            updateRing('copy', 0, 0, 0);
            updateRing('upload', 0, 0, 0);

        } else if (payload.event === "copy_progress") {
            document.getElementById('local-status').textContent = `Copying: ${data.filename}`;
            updateRing('copy', data.current - 1, data.total, data.total);
            addFileRow('local-files', data.filename, 'copying');

        } else if (payload.event === "copy_done") {
            document.getElementById('local-status').textContent = 'Local copy complete.';
            document.getElementById('cloud-status').textContent = 'Uploading to Google Photos...';
            document.getElementById('copy-badge').textContent = 'Done';
            document.getElementById('copy-badge').className = 'px-2.5 py-1 bg-green-100 text-green-700 text-xs font-semibold rounded-full';
            document.getElementById('upload-badge').textContent = 'Uploading';
            document.getElementById('upload-badge').className = 'px-2.5 py-1 bg-purple-100 text-purple-700 text-xs font-semibold rounded-full';

        } else if (payload.event === "upload_progress") {
            document.getElementById('cloud-status').textContent = `Uploading: ${data.filename}`;
            updateRing('upload', data.current - 1, data.total, data.total);
            addFileRow('cloud-files', data.filename, 'uploading');

        } else if (payload.event === "upload_done") {
            document.getElementById('cloud-status').textContent = 'Upload complete.';
            document.getElementById('upload-badge').textContent = 'Done';
            document.getElementById('upload-badge').className = 'px-2.5 py-1 bg-green-100 text-green-700 text-xs font-semibold rounded-full';
        }
    };
});

function updateRing(type, done, total, fullTotal) {
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

function fileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const isVideo = ['mp4','mov','avi','mkv','dng'].includes(ext);
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
    if (status === 'copied') return `<span class="text-xs font-medium text-green-600">(Copied)</span>`;
    if (status === 'copying') return `<span class="text-xs font-medium text-blue-500">(Copying...)</span>`;
    if (status === 'uploading') return `<span class="text-xs font-medium text-purple-500">(Uploading...)</span>`;
    if (status === 'uploaded') return `<span class="text-xs font-medium text-green-600">(Uploaded)</span>`;
    return `<span class="text-xs font-medium text-gray-400">(Queued)</span>`;
}

function addFileRow(listId, filename, status) {
    const list = document.getElementById(listId);
    if (!list) return;
    // Update existing row if present
    const existing = list.querySelector(`[data-file="${CSS.escape(filename)}"]`);
    if (existing) {
        existing.querySelector('.status-chip').innerHTML = statusChip(status);
        return;
    }
    const li = document.createElement('li');
    li.setAttribute('data-file', filename);
    li.className = 'flex items-center gap-2 py-1.5 border-b border-gray-50 last:border-0';
    const name = filename.split('/').pop();
    li.innerHTML = `
        ${fileIcon(filename)}
        <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-gray-700 truncate">${name}</p>
            <span class="status-chip">${statusChip(status)}</span>
        </div>
    `;
    list.insertBefore(li, list.firstChild);
    list.parentElement.scrollTop = 0;
}



async function fetchStorage() {
    try {
        const res = await fetch('/api/system/storage');
        const data = await res.json();
        
        document.getElementById('storage-used').textContent = formatBytes(data.used);
        document.getElementById('storage-free').textContent = formatBytes(data.free) + ' free';
        document.getElementById('storage-total').textContent = formatBytes(data.total) + ' total';
        
        const percent = (data.used / data.total) * 100;
        document.getElementById('storage-bar').style.width = percent + '%';
    } catch (e) {
        console.error("Failed to fetch storage", e);
    }
}

async function fetchActiveDashboard() {
    try {
        const res = await fetch('/api/runs');
        const runs = await res.json();
        if (!runs || runs.length === 0) return;

        const latest = runs[0];

        if (latest.overall_status === 'running' || latest.overall_status === 'completed') {
            const copiedPct = latest.total_files > 0 ? Math.round((latest.copied_files / latest.total_files) * 100) : 0;
            const uploadedPct = latest.total_files > 0 ? Math.round((latest.uploaded_files / latest.total_files) * 100) : 0;

            updateRing('copy', latest.copied_files, latest.total_files, latest.total_files);
            updateRing('upload', latest.uploaded_files, latest.total_files, latest.total_files);

            if (latest.overall_status === 'running') {
                const isCopying = latest.copied_files < latest.total_files;
                document.getElementById('local-status').textContent = isCopying
                    ? `Copying from USB ${latest.usb_identifier}... (${latest.copied_files}/${latest.total_files} files)`
                    : `Copy complete — ${latest.copied_files}/${latest.total_files} files`;
                document.getElementById('cloud-status').textContent = isCopying
                    ? 'Waiting for local copy to complete...'
                    : `Uploading to Google Photos... (${latest.uploaded_files}/${latest.total_files} files)`;
                document.getElementById('copy-badge').textContent = isCopying ? 'Copying' : 'Done';
                document.getElementById('copy-badge').className = isCopying
                    ? 'px-2.5 py-1 bg-blue-100 text-blue-700 text-xs font-semibold rounded-full'
                    : 'px-2.5 py-1 bg-green-100 text-green-700 text-xs font-semibold rounded-full';
                document.getElementById('upload-badge').textContent = isCopying ? 'Waiting' : 'Uploading';
                document.getElementById('upload-badge').className = 'px-2.5 py-1 bg-purple-100 text-purple-700 text-xs font-semibold rounded-full';
            } else {
                document.getElementById('local-status').textContent = `Complete — ${latest.copied_files}/${latest.total_files} files from ${latest.usb_identifier}`;
                document.getElementById('cloud-status').textContent = `Complete — ${latest.uploaded_files}/${latest.total_files} files uploaded`;
                document.getElementById('copy-badge').textContent = 'Done';
                document.getElementById('copy-badge').className = 'px-2.5 py-1 bg-green-100 text-green-700 text-xs font-semibold rounded-full';
                document.getElementById('upload-badge').textContent = 'Done';
                document.getElementById('upload-badge').className = 'px-2.5 py-1 bg-green-100 text-green-700 text-xs font-semibold rounded-full';
            }

            // Populate recent file lists from DB
            const detailRes = await fetch(`/api/runs/${latest.id}`);
            const files = await detailRes.json();

            document.getElementById('local-files').innerHTML = '';
            document.getElementById('cloud-files').innerHTML = '';

            files.slice().reverse().forEach((f, idx) => {
                let copyStatus = 'queued';
                if (f.copy_status === 'success') copyStatus = 'copied';
                else if (f.copy_status === 'pending' && idx === 0) copyStatus = 'copying';
                addFileRow('local-files', f.filename, copyStatus);

                let uploadStatus = 'queued';
                if (f.upload_status === 'success') uploadStatus = 'uploaded';
                else if (f.upload_status === 'pending' && f.copy_status === 'success') uploadStatus = 'queued';
                if (f.copy_status === 'success' || f.upload_status === 'success') {
                    addFileRow('cloud-files', f.filename, uploadStatus);
                }
            });

        } else if (latest.overall_status === 'failed') {
            document.getElementById('local-status').textContent = `Last run failed for device ${latest.usb_identifier}`;
            document.getElementById('copy-badge').textContent = 'Failed';
            document.getElementById('copy-badge').className = 'px-2.5 py-1 bg-red-100 text-red-700 text-xs font-semibold rounded-full';
        }
    } catch (e) {
        console.error("Failed to fetch active dashboard", e);
    }
}

async function fetchHistory() {
    const res = await fetch('/api/runs');
    const runs = await res.json();
    const tbody = document.getElementById('history-body');
    tbody.innerHTML = '';
    runs.forEach(run => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="p-4">${run.id}</td>
            <td class="p-4 font-medium text-gray-900">${run.usb_identifier}</td>
            <td class="p-4 text-gray-500">${run.start_time}</td>
            <td class="p-4 font-semibold text-blue-600">${run.copied_files} / ${run.total_files}</td>
            <td class="p-4 font-semibold text-purple-600">${run.uploaded_files} / ${run.total_files}</td>
            <td class="p-4">
                <span class="px-2 py-1 text-xs font-semibold rounded-full 
                    ${run.overall_status === 'completed' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}">
                    ${run.overall_status}
                </span>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function fetchSettings() {
    try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        
        document.getElementById('gp-auth-data').value = data['GP_AUTH_DATA'] || '';
        document.getElementById('upload-quality').value = data['UPLOAD_QUALITY'] || 'Original Quality';
        document.getElementById('upload-threads').value = data['UPLOAD_THREADS'] || '10';
        document.getElementById('recursive').checked = data['RECURSIVE'] === 'true';
        document.getElementById('auto-album').checked = data['AUTO_ALBUM'] === 'true';
        document.getElementById('skip-existing').checked = data['SKIP_EXISTING'] === 'true';
        document.getElementById('delete-upload').checked = data['DELETE_UPLOAD'] === 'true';
    } catch (e) {
        console.error("Failed to load settings", e);
    }
}

document.getElementById('save-settings-btn').addEventListener('click', async () => {
    const settings = {
        'GP_AUTH_DATA': document.getElementById('gp-auth-data').value,
        'UPLOAD_QUALITY': document.getElementById('upload-quality').value,
        'UPLOAD_THREADS': document.getElementById('upload-threads').value,
        'RECURSIVE': document.getElementById('recursive').checked ? 'true' : 'false',
        'AUTO_ALBUM': document.getElementById('auto-album').checked ? 'true' : 'false',
        'SKIP_EXISTING': document.getElementById('skip-existing').checked ? 'true' : 'false',
        'DELETE_UPLOAD': document.getElementById('delete-upload').checked ? 'true' : 'false',
    };
    
    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings })
        });
        if (res.ok) {
            alert('Settings saved successfully!');
        }
    } catch (e) {
        console.error("Failed to save settings", e);
        alert('Failed to save settings.');
    }
});

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

let currentPath = "";

async function fetchFiles(path = "") {
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
        if (file.type === "directory") {
            const newPath = file.name === ".." ? path.split('/').slice(0, -1).join('/') : (path ? path + '/' + file.name : file.name);
            tr.innerHTML = `
                <td class="p-4 font-medium text-blue-600 flex items-center cursor-pointer hover:underline" onclick="fetchFiles('${newPath}')">
                    <svg class="w-4 h-4 mr-2 text-blue-400" fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"></path></svg>
                    ${file.name}
                </td>
                <td class="p-4 text-gray-500">-</td>
            `;
        } else {
            tr.innerHTML = `
                <td class="p-4 font-medium text-gray-900 flex items-center">
                    <svg class="w-4 h-4 mr-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                    ${file.name}
                </td>
                <td class="p-4 text-gray-500">${formatBytes(file.size)}</td>
            `;
        }
        tbody.appendChild(tr);
    });
}

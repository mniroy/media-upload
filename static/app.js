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
            document.getElementById('local-status').textContent = `Copying from USB ${data.device}...`;
            document.getElementById('local-files').innerHTML = '';
            document.getElementById('cloud-status').textContent = `Waiting for files...`;
            document.getElementById('cloud-files').innerHTML = '';
        } else if (payload.event === "copy_progress") {
            const li = document.createElement('li');
            li.className = "text-sm flex justify-between";
            li.innerHTML = `<span class="truncate text-gray-700 w-3/4">${data.filename}</span> <span class="text-green-600 font-medium">Done</span>`;
            document.getElementById('local-files').appendChild(li);
            // Auto scroll
            const container = document.getElementById('local-files').parentElement;
            container.scrollTop = container.scrollHeight;
        } else if (payload.event === "copy_done") {
            document.getElementById('local-status').textContent = "Local copy complete.";
            document.getElementById('cloud-status').textContent = "Uploading to Cloud...";
        } else if (payload.event === "upload_progress") {
            const li = document.createElement('li');
            li.className = "text-sm flex justify-between";
            li.innerHTML = `<span class="truncate text-gray-700 w-3/4">${data.filename}</span> <span class="text-purple-600 font-medium">Done</span>`;
            document.getElementById('cloud-files').appendChild(li);
            // Auto scroll
            const container = document.getElementById('cloud-files').parentElement;
            container.scrollTop = container.scrollHeight;
        } else if (payload.event === "upload_done") {
            document.getElementById('cloud-status').textContent = "Cloud upload complete.";
        }
    };
});

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

        const latest = runs[0]; // most recent first

        if (latest.overall_status === 'running') {
            // Show live in-progress state
            const isCopying = latest.copied_files < latest.total_files;
            document.getElementById('local-status').textContent =
                `Copying from USB ${latest.usb_identifier}... (${latest.copied_files}/${latest.total_files} files)`;
            document.getElementById('cloud-status').textContent = isCopying
                ? 'Waiting for local copy to complete...'
                : `Uploading to Cloud... (${latest.uploaded_files}/${latest.total_files} files)`;

            // Fetch file details and populate lists
            const detailRes = await fetch(`/api/runs/${latest.id}`);
            const files = await detailRes.json();

            const localList = document.getElementById('local-files');
            const cloudList = document.getElementById('cloud-files');
            localList.innerHTML = '';
            cloudList.innerHTML = '';

            files.forEach(f => {
                if (f.copy_status === 'success') {
                    const li = document.createElement('li');
                    li.className = 'text-sm flex justify-between';
                    li.innerHTML = `<span class="truncate text-gray-700 w-3/4">${f.filename}</span> <span class="text-green-600 font-medium">Copied</span>`;
                    localList.appendChild(li);
                }
                if (f.upload_status === 'success') {
                    const li = document.createElement('li');
                    li.className = 'text-sm flex justify-between';
                    li.innerHTML = `<span class="truncate text-gray-700 w-3/4">${f.filename}</span> <span class="text-purple-600 font-medium">Uploaded</span>`;
                    cloudList.appendChild(li);
                }
            });

            // Auto-scroll to bottom
            localList.parentElement.scrollTop = localList.parentElement.scrollHeight;
            cloudList.parentElement.scrollTop = cloudList.parentElement.scrollHeight;

        } else if (latest.overall_status === 'completed') {
            document.getElementById('local-status').textContent =
                `Last run complete — ${latest.copied_files}/${latest.total_files} files copied from ${latest.usb_identifier}`;
            document.getElementById('cloud-status').textContent =
                `Last run complete — ${latest.uploaded_files}/${latest.total_files} files uploaded`;
        } else if (latest.overall_status === 'failed') {
            document.getElementById('local-status').textContent =
                `Last run failed for device ${latest.usb_identifier}`;
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

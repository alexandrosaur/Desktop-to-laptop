let socket = null;
let currentSessionId = null;
let currentUsername = null;
let selectedFiles = [];
let sessionFiles = new Map(); // Store files in current session for export

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    connectSocket();
    setupButtons();
    loadSavedSessionsList();
});

function connectSocket() {
    socket = io();
    
    socket.on('connect', () => {
        console.log('Connected to server');
    });
    
    socket.on('disconnect', () => {
        console.log('Disconnected');
        if (currentSessionId) {
            showMessage('system', 'Disconnected from server');
            document.getElementById('online-status').className = 'status offline';
        }
    });
    
    socket.on('history', (messages) => {
        console.log('Received history:', messages.length);
        displayMessages(messages);
    });
    
    socket.on('file-list', (files) => {
        console.log('Received file list:', files.length);
        displaySharedFiles(files);
        // Store files locally for export
        files.forEach(file => {
            if (!sessionFiles.has(file.fileId)) {
                sessionFiles.set(file.fileId, file);
            }
        });
    });
    
    socket.on('new-message', (message) => {
        addMessageToChat(message);
    });
    
    socket.on('user-joined', (data) => {
        showMessage('system', data.message);
    });
    
    socket.on('user-left', (data) => {
        showMessage('system', data.message);
    });
    
    socket.on('new-file', async (file) => {
        addFileToList(file);
        showMessage('system', `${file.uploadedBy} uploaded ${file.fileName}`);
        
        // Fetch the actual file data for storage
        try {
            const response = await fetch(`/download/${currentSessionId}/${file.fileId}`);
            const blob = await response.blob();
            const reader = new FileReader();
            reader.onload = () => {
                sessionFiles.set(file.fileId, {
                    ...file,
                    fileData: reader.result
                });
            };
            reader.readAsDataURL(blob);
        } catch (error) {
            console.error('Failed to fetch file data:', error);
        }
    });
    
    socket.on('error', (data) => {
        alert(data.error);
    });
}

function setupButtons() {
    // Login screen
    document.getElementById('create-btn').onclick = () => showScreen('create-screen');
    document.getElementById('show-join-btn').onclick = () => showScreen('join-screen');
    
    // Create session
    document.getElementById('confirm-create-btn').onclick = createSession;
    document.getElementById('back-from-create-btn').onclick = () => showScreen('login-screen');
    
    // Join session
    document.getElementById('confirm-join-btn').onclick = joinSession;
    document.getElementById('back-from-join-btn').onclick = () => showScreen('login-screen');
    
    // Main screen
    document.getElementById('leave-btn').onclick = leaveSession;
    document.getElementById('send-msg-btn').onclick = sendMessage;
    document.getElementById('message-input').onkeypress = (e) => {
        if (e.key === 'Enter') sendMessage();
    };
    document.getElementById('select-file-btn').onclick = () => {
        document.getElementById('file-input').click();
    };
    document.getElementById('file-input').onchange = handleFileSelect;
    document.getElementById('upload-files-btn').onclick = uploadFiles;
    document.getElementById('save-chat-btn').onclick = exportSessionToFile;
    document.getElementById('load-chat-btn').onclick = () => {
        document.getElementById('restore-file-input').click();
    };
    document.getElementById('restore-file-input').onchange = importSessionFromFile;
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    document.getElementById(screenId).classList.add('active');
}

function createSession() {
    const username = document.getElementById('login-username').value.trim();
    const sessionName = document.getElementById('create-session-name').value.trim();
    
    if (!username) {
        alert('Please enter your name');
        return;
    }
    if (!sessionName) {
        alert('Please enter a session name');
        return;
    }
    if (sessionName.length < 2) {
        alert('Session name must be at least 2 characters');
        return;
    }
    
    currentUsername = username;
    currentSessionId = sessionName;
    
    socket.emit('create-session', { sessionId: sessionName, username }, (response) => {
        if (response.success) {
            document.getElementById('current-session').textContent = sessionName;
            document.getElementById('current-user').textContent = username;
            showScreen('main-screen');
            showMessage('system', `Session "${sessionName}" created! Share this name to let others join.`);
        } else {
            alert(response.error);
        }
    });
}

function joinSession() {
    const username = document.getElementById('login-username').value.trim();
    const sessionName = document.getElementById('join-session-name').value.trim();
    
    if (!username) {
        alert('Please enter your name');
        return;
    }
    if (!sessionName) {
        alert('Please enter the session name to join');
        return;
    }
    
    currentUsername = username;
    currentSessionId = sessionName;
    
    socket.emit('join-session', { sessionId: sessionName, username }, (response) => {
        if (response.success) {
            document.getElementById('current-session').textContent = sessionName;
            document.getElementById('current-user').textContent = username;
            showScreen('main-screen');
            showMessage('system', `Joined session "${sessionName}"`);
        } else {
            alert(response.error);
        }
    });
}

function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    
    if (!text || !currentSessionId) return;
    
    socket.emit('send-message', {
        sessionId: currentSessionId,
        message: text
    });
    
    input.value = '';
}

function addMessageToChat(message) {
    const container = document.getElementById('messages-container');
    
    if (container.querySelector('.empty-state')) {
        container.innerHTML = '';
    }
    
    const messageDiv = document.createElement('div');
    const isOwn = message.username === currentUsername;
    messageDiv.className = `message ${isOwn ? 'message-own' : 'message-other'}`;
    
    const time = new Date(message.timestamp).toLocaleTimeString();
    
    if (message.isFile) {
        messageDiv.innerHTML = `
            <div class="message-header">${escapeHtml(message.username)} • ${time}</div>
            <div class="message-content">
                📁 ${escapeHtml(message.text)}
                <button onclick="window.downloadFile('${message.fileId}', '${escapeHtml(message.fileName)}')" class="download-btn">Download</button>
            </div>
        `;
    } else {
        messageDiv.innerHTML = `
            <div class="message-header">${escapeHtml(message.username)} • ${time}</div>
            <div class="message-content">${escapeHtml(message.text)}</div>
        `;
    }
    
    container.appendChild(messageDiv);
    container.scrollTop = container.scrollHeight;
}

function displayMessages(messages) {
    const container = document.getElementById('messages-container');
    container.innerHTML = '';
    
    if (!messages || messages.length === 0) {
        container.innerHTML = '<div class="empty-state">No messages yet</div>';
        return;
    }
    
    messages.forEach(msg => addMessageToChat(msg));
}

function showMessage(type, text) {
    const container = document.getElementById('messages-container');
    
    if (container.querySelector('.empty-state')) {
        container.innerHTML = '';
    }
    
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message system-message';
    msgDiv.innerHTML = `<div class="message-content">ℹ️ ${escapeHtml(text)}</div>`;
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
}

function handleFileSelect(event) {
    selectedFiles = Array.from(event.target.files);
    const container = document.getElementById('selected-files-list');
    container.innerHTML = '';
    
    if (selectedFiles.length === 0) return;
    
    selectedFiles.forEach(file => {
        const fileDiv = document.createElement('div');
        fileDiv.className = 'selected-file';
        fileDiv.innerHTML = `
            <span>📄 ${escapeHtml(file.name)}</span>
            <span>${(file.size / 1024).toFixed(1)} KB</span>
        `;
        container.appendChild(fileDiv);
    });
    
    document.getElementById('upload-files-btn').disabled = false;
}

async function uploadFiles() {
    if (selectedFiles.length === 0) return;
    
    for (const file of selectedFiles) {
        const fileId = `${Date.now()}-${file.name.replace(/[^a-z0-9]/gi, '_')}`;
        
        showMessage('system', `Uploading ${file.name}...`);
        
        const reader = new FileReader();
        const fileData = await new Promise((resolve) => {
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(file);
        });
        
        // Store file locally for export
        sessionFiles.set(fileId, {
            fileId: fileId,
            fileName: file.name,
            fileSize: file.size,
            uploadedBy: currentUsername,
            timestamp: Date.now(),
            fileData: fileData
        });
        
        socket.emit('upload-file', {
            sessionId: currentSessionId,
            fileId,
            fileName: file.name,
            fileSize: file.size,
            fileData
        }, (response) => {
            if (response && response.success) {
                showMessage('system', `✅ ${file.name} uploaded!`);
            } else {
                showMessage('system', `❌ Failed to upload ${file.name}`);
            }
        });
    }
    
    selectedFiles = [];
    document.getElementById('selected-files-list').innerHTML = '';
    document.getElementById('upload-files-btn').disabled = true;
    document.getElementById('file-input').value = '';
}

function displaySharedFiles(files) {
    const container = document.getElementById('shared-files');
    container.innerHTML = '';
    
    if (!files || files.length === 0) {
        container.innerHTML = '<div class="empty-state">No files shared yet</div>';
        return;
    }
    
    files.forEach(file => addFileToList(file));
}

function addFileToList(file) {
    const container = document.getElementById('shared-files');
    
    if (container.querySelector('.empty-state')) {
        container.innerHTML = '';
    }
    
    const fileDiv = document.createElement('div');
    fileDiv.className = 'shared-file';
    const date = new Date(file.timestamp).toLocaleTimeString();
    
    fileDiv.innerHTML = `
        <div class="file-info">
            <span class="file-icon">📄</span>
            <div>
                <div class="file-name">${escapeHtml(file.fileName)}</div>
                <div class="file-meta">${(file.fileSize / 1024 / 1024).toFixed(2)} MB • by ${escapeHtml(file.uploadedBy)} • ${date}</div>
            </div>
        </div>
        <button onclick="window.downloadFile('${file.fileId}', '${escapeHtml(file.fileName)}')" class="download-small">⬇️</button>
    `;
    
    container.appendChild(fileDiv);
}

window.downloadFile = function(fileId, fileName) {
    const url = `/download/${currentSessionId}/${fileId}`;
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

// Export session with files to a downloadable file
async function exportSessionToFile() {
    showMessage('system', '📦 Packaging session with files...');
    
    // Collect all messages from the chat
    const messages = [];
    const messageDivs = document.querySelectorAll('#messages-container .message');
    
    messageDivs.forEach(div => {
        const header = div.querySelector('.message-header');
        const content = div.querySelector('.message-content');
        if (header && content) {
            let username = 'system';
            if (div.classList.contains('message-own')) username = currentUsername;
            else if (div.classList.contains('message-other')) {
                const headerText = header.innerText;
                username = headerText.split('•')[0].trim();
            }
            
            let text = content.innerText;
            if (text.includes('Download')) {
                text = text.split('Download')[0].trim();
            }
            
            let timestamp = new Date().toISOString();
            const headerText = header.innerText;
            const timeMatch = headerText.match(/• (.+)$/);
            if (timeMatch) {
                const timeStr = timeMatch[1];
                const today = new Date();
                const [hours, minutes, seconds] = timeStr.split(':');
                today.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds || '0'));
                timestamp = today.toISOString();
            }
            
            messages.push({
                text: text,
                username: username,
                timestamp: timestamp
            });
        }
    });
    
    // Collect all files from the session
    const files = [];
    for (const [fileId, file] of sessionFiles.entries()) {
        // If we don't have the file data yet, try to fetch it
        let fileData = file.fileData;
        if (!fileData && currentSessionId) {
            try {
                const response = await fetch(`/download/${currentSessionId}/${fileId}`);
                const blob = await response.blob();
                const reader = new FileReader();
                fileData = await new Promise((resolve) => {
                    reader.onload = () => resolve(reader.result);
                    reader.readAsDataURL(blob);
                });
            } catch (error) {
                console.error(`Failed to fetch file ${file.fileName}:`, error);
            }
        }
        
        files.push({
            fileId: file.fileId,
            fileName: file.fileName,
            fileSize: file.fileSize,
            uploadedBy: file.uploadedBy,
            timestamp: file.timestamp,
            fileData: fileData || null
        });
    }
    
    // Create session export object with all metadata AND files
    const sessionExport = {
        version: "2.0",
        exportedAt: new Date().toISOString(),
        session: {
            name: currentSessionId,
            createdAt: new Date().toISOString(),
            lastActive: new Date().toISOString()
        },
        messages: messages,
        files: files,
        metadata: {
            messageCount: messages.length,
            fileCount: files.length,
            exportedBy: currentUsername,
            exportDate: new Date().toLocaleString()
        }
    };
    
    // Create filename
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 19).replace(/:/g, '-');
    const safeSessionName = currentSessionId.replace(/[^a-z0-9]/gi, '_');
    const filename = `session_${safeSessionName}_${dateStr}.json`;
    
    // Download the file
    const dataStr = JSON.stringify(sessionExport, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    
    const fileSizeKB = (dataStr.length / 1024).toFixed(1);
    showMessage('system', `✅ Session exported to "${filename}" (${messages.length} messages, ${files.length} files, ${fileSizeKB} KB saved to your laptop)`);
    
    // Save to recent sessions list
    addToSavedSessionsList({
        filename: filename,
        sessionName: currentSessionId,
        date: dateStr,
        messageCount: messages.length,
        fileCount: files.length
    });
}

// Import session with files from file
function importSessionFromFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    showMessage('system', `📂 Loading "${file.name}"...`);
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const sessionData = JSON.parse(e.target.result);
            
            // Validate the session data
            if (!sessionData.messages) {
                showMessage('system', '❌ Invalid session file format', 'error');
                return;
            }
            
            // Display the messages
            displayMessages(sessionData.messages);
            
            // Show session info
            showMessage('system', `✅ Loaded session "${sessionData.session.name}" from ${new Date(sessionData.exportedAt).toLocaleString()}`);
            showMessage('system', `📊 ${sessionData.messages.length} messages restored`);
            
            // Restore files if any
            if (sessionData.files && sessionData.files.length > 0) {
                showMessage('system', `📁 Found ${sessionData.files.length} files in the session`);
                
                // Store files locally
                sessionData.files.forEach(file => {
                    if (file.fileData) {
                        sessionFiles.set(file.fileId, file);
                        showMessage('system', `  • ${file.fileName} (${(file.fileSize / 1024 / 1024).toFixed(2)} MB) - ready to download`);
                    }
                });
                
                // Display files in the shared files section
                displaySharedFiles(sessionData.files);
                
                // Add download buttons to file messages
                sessionData.messages.forEach(msg => {
                    if (msg.isFile || msg.text.includes('Uploaded:')) {
                        // Find the file in sessionData.files
                        const fileMatch = sessionData.files.find(f => f.fileName === msg.fileName);
                        if (fileMatch && fileMatch.fileData) {
                            // The download button will work using the stored fileData
                            window.storedFiles = window.storedFiles || {};
                            window.storedFiles[fileMatch.fileId] = fileMatch.fileData;
                        }
                    }
                });
            }
            
            // If in an active session, also restore to server
            if (currentSessionId && socket) {
                socket.emit('restore-history', {
                    sessionId: currentSessionId,
                    history: sessionData.messages
                });
                showMessage('system', `📤 Restored to active session "${currentSessionId}"`);
            }
            
            // Add to recent sessions list
            addToSavedSessionsList({
                filename: file.name,
                sessionName: sessionData.session.name,
                date: sessionData.exportedAt,
                messageCount: sessionData.messages.length,
                fileCount: sessionData.files ? sessionData.files.length : 0
            });
            
        } catch (error) {
            console.error('Import error:', error);
            showMessage('system', '❌ Failed to load session file', 'error');
        }
    };
    reader.readAsText(file);
    
    // Clear the input
    event.target.value = '';
}

// Override download function to work with stored files from imports
window.downloadFile = function(fileId, fileName) {
    // First check if we have the file stored locally (from import)
    if (window.storedFiles && window.storedFiles[fileId]) {
        const link = document.createElement('a');
        link.href = window.storedFiles[fileId];
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showMessage('system', `📥 Downloaded "${fileName}" from saved session`);
        return;
    }
    
    // Otherwise download from server
    const url = `/download/${currentSessionId}/${fileId}`;
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

function addToSavedSessionsList(sessionInfo) {
    let savedSessions = JSON.parse(localStorage.getItem('savedSessions') || '[]');
    
    const exists = savedSessions.some(s => s.filename === sessionInfo.filename);
    if (!exists) {
        savedSessions.unshift(sessionInfo);
        if (savedSessions.length > 20) savedSessions = savedSessions.slice(0, 20);
        localStorage.setItem('savedSessions', JSON.stringify(savedSessions));
    }
    
    loadSavedSessionsList();
}

function loadSavedSessionsList() {
    const savedSessions = JSON.parse(localStorage.getItem('savedSessions') || '[]');
    const container = document.getElementById('saved-sessions-list');
    container.innerHTML = '';
    
    if (savedSessions.length === 0) {
        container.innerHTML = '<div class="empty-state">No saved sessions yet.<br>Click "Save to File" to download a session to your laptop</div>';
        return;
    }
    
    savedSessions.forEach(session => {
        const div = document.createElement('div');
        div.className = 'saved-item';
        const date = new Date(session.date).toLocaleString();
        div.innerHTML = `
            <div>📁 ${escapeHtml(session.sessionName)}</div>
            <div>📅 ${date}</div>
            <div>💬 ${session.messageCount} messages</div>
            ${session.fileCount ? `<div>📎 ${session.fileCount} files</div>` : ''}
            <div class="file-name-hint">📄 ${escapeHtml(session.filename)}</div>
        `;
        div.onclick = () => {
            showMessage('system', `To load "${session.sessionName}", click "Load from File" and select: ${session.filename}`);
        };
        container.appendChild(div);
    });
}

function leaveSession() {
    if (socket && currentSessionId) {
        socket.emit('leave-session');
    }
    currentSessionId = null;
    currentUsername = null;
    selectedFiles = [];
    sessionFiles.clear();
    window.storedFiles = {};
    showScreen('login-screen');
    document.getElementById('login-username').value = '';
    document.getElementById('create-session-name').value = '';
    document.getElementById('join-session-name').value = '';
    document.getElementById('messages-container').innerHTML = '<div class="empty-state">No messages yet</div>';
    document.getElementById('shared-files').innerHTML = '<div class="empty-state">No files shared yet</div>';
    document.getElementById('selected-files-list').innerHTML = '';
    document.getElementById('upload-files-btn').disabled = true;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
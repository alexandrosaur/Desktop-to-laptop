const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e8
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));

// Store logs in memory for viewing via API
const eventLogs = [];
const MAX_LOGS = 1000;

function addLog(type, message, data = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    type: type, // 'info', 'error', 'session', 'user', 'file'
    message: message,
    data: data
  };
  eventLogs.unshift(logEntry); // Add to beginning
  if (eventLogs.length > MAX_LOGS) eventLogs.pop();
  
  // Also print to console for Render logs
  console.log(`[${type.toUpperCase()}] ${message}`);
  if (data) console.log(`  └─ ${JSON.stringify(data)}`);
}

// Serve static files
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// Store sessions
const sessions = new Map();

class Session {
  constructor(sessionId, creator) {
    this.sessionId = sessionId;
    this.users = new Map();
    this.messages = [];
    this.files = new Map();
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.creator = creator;
  }

  getMemoryUsage() {
    let total = 0;
    this.messages.forEach(msg => {
      total += 200 + (msg.text?.length || 0);
    });
    this.files.forEach(file => {
      if (file.data) total += file.data.length * 0.75;
      total += 200;
    });
    total += this.users.size * 500;
    total += 1000;
    return total;
  }
}

// Real-time stats tracking
let lastStatsLog = Date.now();

function logStats() {
  const totalUsers = Array.from(sessions.values()).reduce((sum, s) => sum + s.users.size, 0);
  const totalSessions = sessions.size;
  const totalMemory = Array.from(sessions.values()).reduce((sum, s) => sum + s.getMemoryUsage(), 0);
  const nodeMemory = process.memoryUsage();
  
  const stats = {
    users: totalUsers,
    sessions: totalSessions,
    memoryMB: (totalMemory / 1024 / 1024).toFixed(2),
    nodeHeapMB: (nodeMemory.heapUsed / 1024 / 1024).toFixed(2),
    timestamp: new Date().toISOString()
  };
  
  addLog('stats', `Users: ${stats.users} | Sessions: ${stats.sessions} | Memory: ${stats.memoryMB} MB | Node: ${stats.nodeHeapMB} MB`, stats);
  
  // Log individual sessions if any exist
  if (totalSessions > 0) {
    for (const [id, session] of sessions.entries()) {
      const userList = Array.from(session.users.values()).map(u => u.username);
      addLog('session', `Session "${id}" | Users: ${session.users.size} (${userList.join(', ') || 'none'}) | Messages: ${session.messages.length} | Files: ${session.files.size}`, {
        sessionId: id,
        users: session.users.size,
        userNames: userList,
        messages: session.messages.length,
        files: session.files.size,
        memoryKB: (session.getMemoryUsage() / 1024).toFixed(2)
      });
    }
  }
  
  lastStatsLog = Date.now();
}

// Log stats every 30 seconds (more frequent for Render)
setInterval(logStats, 30000);

// Clean up old sessions
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [id, session] of sessions.entries()) {
    if (session.users.size === 0 && now - session.lastActivity > 600000) {
      addLog('cleanup', `Deleting inactive session: "${id}" (idle for ${Math.round((now - session.lastActivity)/1000)}s)`);
      sessions.delete(id);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    addLog('cleanup', `Removed ${cleanedCount} inactive sessions`);
  }
}, 60000);

// API endpoint to get logs
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const type = req.query.type;
  
  let logs = eventLogs.slice(0, limit);
  if (type) {
    logs = logs.filter(log => log.type === type);
  }
  
  res.json({
    count: logs.length,
    total: eventLogs.length,
    logs: logs
  });
});

// API endpoint to get detailed stats
app.get('/api/stats', (req, res) => {
  const totalUsers = Array.from(sessions.values()).reduce((sum, s) => sum + s.users.size, 0);
  const totalMemory = Array.from(sessions.values()).reduce((sum, s) => sum + s.getMemoryUsage(), 0);
  const nodeMemory = process.memoryUsage();
  
  const sessionsData = Array.from(sessions.entries()).map(([id, session]) => ({
    id: id,
    users: session.users.size,
    userNames: Array.from(session.users.values()).map(u => u.username),
    messages: session.messages.length,
    files: session.files.size,
    memoryKB: (session.getMemoryUsage() / 1024).toFixed(2),
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    isActive: session.users.size > 0,
    idleSeconds: session.users.size === 0 ? Math.round((Date.now() - session.lastActivity) / 1000) : 0
  }));
  
  res.json({
    timestamp: new Date().toISOString(),
    summary: {
      totalSessions: sessions.size,
      totalUsers: totalUsers,
      totalMemoryMB: (totalMemory / 1024 / 1024).toFixed(2),
      nodeMemoryMB: {
        heapUsed: (nodeMemory.heapUsed / 1024 / 1024).toFixed(2),
        heapTotal: (nodeMemory.heapTotal / 1024 / 1024).toFixed(2),
        rss: (nodeMemory.rss / 1024 / 1024).toFixed(2)
      },
      systemMemoryGB: {
        free: (os.freemem() / 1024 / 1024 / 1024).toFixed(2),
        total: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2)
      }
    },
    sessions: sessionsData
  });
});

// Simple stats endpoint
app.get('/api/stats/simple', (req, res) => {
  const totalUsers = Array.from(sessions.values()).reduce((sum, s) => sum + s.users.size, 0);
  res.json({
    users: totalUsers,
    sessions: sessions.size,
    timestamp: new Date().toISOString()
  });
});

// Download endpoint
app.get('/download/:sessionId/:fileId', (req, res) => {
  const { sessionId, fileId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session || !session.files.has(fileId)) {
    addLog('error', `Download failed: Session "${sessionId}", File "${fileId}" not found`);
    return res.status(404).json({ error: 'File not found' });
  }
  
  const file = session.files.get(fileId);
  const buffer = Buffer.from(file.data.split(',')[1], 'base64');
  
  addLog('file', `Downloaded "${file.name}" (${(file.size / 1024 / 1024).toFixed(2)} MB) from session "${sessionId}"`, {
    fileName: file.name,
    fileSize: file.size,
    sessionId: sessionId,
    user: file.uploadedBy
  });
  
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
  res.send(buffer);
});

io.on('connection', (socket) => {
  addLog('connection', `New client connected: ${socket.id}`);
  
  socket.on('create-session', ({ sessionId, username }, callback) => {
    addLog('session', `Create request: "${sessionId}" by "${username}"`);
    
    if (!sessionId || sessionId.length < 2) {
      addLog('error', `Create failed: Invalid session name "${sessionId}"`);
      callback({ success: false, error: 'Session name must be at least 2 characters' });
      return;
    }
    
    if (sessions.has(sessionId)) {
      addLog('error', `Create failed: Session "${sessionId}" already exists`);
      callback({ success: false, error: 'Session name already taken' });
      return;
    }
    
    const session = new Session(sessionId, username);
    sessions.set(sessionId, session);
    session.users.set(socket.id, { username, deviceType: 'creator' });
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.username = username;
    
    addLog('session', `✅ Session "${sessionId}" created by "${username}"`);
    callback({ success: true, sessionId });
  });
  
  socket.on('join-session', ({ sessionId, username }, callback) => {
    addLog('session', `Join request: "${username}" -> "${sessionId}"`);
    
    const session = sessions.get(sessionId);
    if (!session) {
      addLog('error', `Join failed: Session "${sessionId}" not found`);
      callback({ success: false, error: `Session "${sessionId}" not found` });
      return;
    }
    
    let duplicate = false;
    for (const [_, user] of session.users) {
      if (user.username === username) {
        duplicate = true;
        break;
      }
    }
    
    if (duplicate) {
      addLog('error', `Join failed: Username "${username}" already taken in "${sessionId}"`);
      callback({ success: false, error: `Username "${username}" already taken` });
      return;
    }
    
    session.users.set(socket.id, { username, deviceType: 'joiner' });
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.username = username;
    session.lastActivity = Date.now();
    
    addLog('session', `✅ "${username}" joined session "${sessionId}" (now ${session.users.size} users)`);
    
    socket.emit('history', session.messages);
    
    const fileList = Array.from(session.files.entries()).map(([id, file]) => ({
      fileId: id,
      fileName: file.name,
      fileSize: file.size,
      uploadedBy: file.uploadedBy,
      timestamp: file.timestamp
    }));
    socket.emit('file-list', fileList);
    
    socket.to(sessionId).emit('user-joined', {
      message: `${username} joined the session`,
      username
    });
    
    callback({ success: true, sessionId });
  });
  
  socket.on('send-message', ({ sessionId, message }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    
    const user = session.users.get(socket.id);
    if (!user) return;
    
    addLog('message', `"${user.username}" in "${sessionId}": ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
    
    const messageObj = {
      id: Date.now(),
      text: message,
      username: user.username,
      timestamp: new Date().toISOString()
    };
    
    session.messages.push(messageObj);
    session.lastActivity = Date.now();
    
    if (session.messages.length > 500) {
      session.messages = session.messages.slice(-500);
    }
    
    io.to(sessionId).emit('new-message', messageObj);
  });
  
  socket.on('upload-file', ({ sessionId, fileId, fileName, fileSize, fileData }, callback) => {
    const session = sessions.get(sessionId);
    if (!session) {
      callback({ success: false, error: 'Session not found' });
      return;
    }
    
    const user = session.users.get(socket.id);
    if (!user) return;
    
    addLog('file', `Uploading "${fileName}" (${(fileSize / 1024 / 1024).toFixed(2)} MB) by "${user.username}" to "${sessionId}"`);
    
    session.files.set(fileId, {
      name: fileName,
      size: fileSize,
      data: fileData,
      uploadedBy: user.username,
      timestamp: Date.now()
    });
    session.lastActivity = Date.now();
    
    io.to(sessionId).emit('new-file', {
      fileId,
      fileName,
      fileSize,
      uploadedBy: user.username,
      timestamp: Date.now()
    });
    
    const messageObj = {
      id: Date.now(),
      text: `📁 Uploaded: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`,
      username: user.username,
      timestamp: new Date().toISOString(),
      isFile: true,
      fileId,
      fileName
    };
    
    session.messages.push(messageObj);
    io.to(sessionId).emit('new-message', messageObj);
    
    addLog('file', `✅ Upload complete: "${fileName}" to "${sessionId}"`);
    callback({ success: true });
  });
  
  socket.on('restore-history', ({ sessionId, history }) => {
    const session = sessions.get(sessionId);
    if (session && history) {
      addLog('session', `Restoring ${history.length} messages to session "${sessionId}"`);
      session.messages = history;
      session.lastActivity = Date.now();
    }
  });
  
  socket.on('leave-session', () => {
    if (socket.sessionId) {
      const session = sessions.get(socket.sessionId);
      if (session) {
        const user = session.users.get(socket.id);
        if (user) {
          addLog('session', `"${user.username}" left session "${socket.sessionId}" (${session.users.size - 1} users remaining)`);
          session.users.delete(socket.id);
          session.lastActivity = Date.now();
          socket.to(socket.sessionId).emit('user-left', {
            message: `${user.username} left the session`
          });
        }
      }
      socket.leave(socket.sessionId);
      delete socket.sessionId;
    }
  });
  
  socket.on('disconnect', () => {
    addLog('connection', `Client disconnected: ${socket.id} (${socket.username || 'unknown'})`);
    
    if (socket.sessionId) {
      const session = sessions.get(socket.sessionId);
      if (session) {
        const user = session.users.get(socket.id);
        if (user) {
          addLog('session', `"${user.username}" disconnected from "${socket.sessionId}" (${session.users.size - 1} users remaining)`);
          session.users.delete(socket.id);
          socket.to(socket.sessionId).emit('user-left', {
            message: `${user.username} disconnected`
          });
        }
      }
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  const totalUsers = Array.from(sessions.values()).reduce((sum, s) => sum + s.users.size, 0);
  const totalMemory = Array.from(sessions.values()).reduce((sum, s) => sum + s.getMemoryUsage(), 0);
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    stats: {
      sessions: sessions.size,
      users: totalUsers,
      memoryMB: (totalMemory / 1024 / 1024).toFixed(2),
      nodeMemoryMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)
    },
    uptime: process.uptime()
  });
});

// Serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(60));
  console.log(`🚀 FILE EXCHANGE SERVER RUNNING`);
  console.log('='.repeat(60));
  console.log(`📍 Port: ${PORT}`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`📊 Stats: http://localhost:${PORT}/api/stats`);
  console.log(`📋 Logs: http://localhost:${PORT}/api/logs`);
  console.log('='.repeat(60) + '\n');
  
  // Initial stats log
  logStats();
});
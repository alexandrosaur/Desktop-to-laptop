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

  // Calculate memory usage of this session (approximate)
  getMemoryUsage() {
    let total = 0;
    
    // Messages memory (rough estimate: 200 bytes per message + text length)
    this.messages.forEach(msg => {
      total += 200 + (msg.text?.length || 0);
    });
    
    // Files memory (base64 data is ~1.33x original size)
    this.files.forEach(file => {
      if (file.data) {
        total += file.data.length * 0.75; // Approximate original size
      }
      total += 200; // Metadata overhead
    });
    
    // Users memory (~500 bytes per user)
    total += this.users.size * 500;
    
    // Session overhead
    total += 1000;
    
    return total;
  }
}

// Clean up old sessions
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [id, session] of sessions.entries()) {
    if (session.users.size === 0 && now - session.lastActivity > 600000) {
      console.log(`🗑️ [CLEANUP] Deleting inactive session: "${id}" (no users for ${Math.round((now - session.lastActivity)/1000)}s)`);
      sessions.delete(id);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`🧹 [CLEANUP] Removed ${cleanedCount} inactive sessions`);
  }
}, 60000); // Run every minute

// Logging interval - runs every minute
setInterval(() => {
  const now = new Date().toISOString();
  const totalUsers = Array.from(sessions.values()).reduce((sum, s) => sum + s.users.size, 0);
  const totalSessions = sessions.size;
  let totalMemory = 0;
  
  // Calculate total memory usage
  const sessionDetails = [];
  for (const [id, session] of sessions.entries()) {
    const mem = session.getMemoryUsage();
    totalMemory += mem;
    sessionDetails.push({
      id: id,
      users: session.users.size,
      messages: session.messages.length,
      files: session.files.size,
      memoryKB: (mem / 1024).toFixed(2),
      createdAgo: Math.round((Date.now() - session.createdAt) / 60000) + 'min',
      idleTime: session.users.size === 0 ? Math.round((Date.now() - session.lastActivity) / 1000) + 's' : 'active'
    });
  }
  
  // System memory info
  const totalSystemMemory = os.totalmem();
  const freeSystemMemory = os.freemem();
  const usedSystemMemory = totalSystemMemory - freeSystemMemory;
  const nodeMemory = process.memoryUsage();
  
  console.log('\n' + '='.repeat(80));
  console.log(`📊 [STATS] ${now}`);
  console.log('='.repeat(80));
  console.log(`👥 Users Online: ${totalUsers}`);
  console.log(`📁 Active Sessions: ${totalSessions}`);
  console.log(`💾 Session Memory Usage: ${(totalMemory / 1024 / 1024).toFixed(2)} MB`);
  console.log(`🖥️ Node.js Memory: ${(nodeMemory.heapUsed / 1024 / 1024).toFixed(2)} MB / ${(nodeMemory.heapTotal / 1024 / 1024).toFixed(2)} MB (heap)`);
  console.log(`💻 System Memory: ${(usedSystemMemory / 1024 / 1024 / 1024).toFixed(2)} GB / ${(totalSystemMemory / 1024 / 1024 / 1024).toFixed(2)} GB used`);
  
  if (sessionDetails.length > 0) {
    console.log('\n📋 Session Details:');
    console.log('-'.repeat(80));
    sessionDetails.forEach(s => {
      console.log(`  🔸 "${s.id}" | Users: ${s.users} | Msgs: ${s.messages} | Files: ${s.files} | Memory: ${s.memoryKB} KB | Age: ${s.createdAgo} | Status: ${s.idleTime}`);
    });
  } else {
    console.log('\n📋 No active sessions');
  }
  console.log('='.repeat(80) + '\n');
  
}, 60000); // Every minute

// Also log on session creation/deletion
function logSessions() {
  const totalUsers = Array.from(sessions.values()).reduce((sum, s) => sum + s.users.size, 0);
  console.log(`📈 [LIVE] Users: ${totalUsers} | Sessions: ${sessions.size} | Memory: ${(Array.from(sessions.values()).reduce((sum, s) => sum + s.getMemoryUsage(), 0) / 1024 / 1024).toFixed(2)} MB`);
}

// Download endpoint
app.get('/download/:sessionId/:fileId', (req, res) => {
  const { sessionId, fileId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session || !session.files.has(fileId)) {
    console.log(`❌ [DOWNLOAD] Failed - Session: ${sessionId}, File: ${fileId} (not found)`);
    return res.status(404).json({ error: 'File not found' });
  }
  
  const file = session.files.get(fileId);
  const buffer = Buffer.from(file.data.split(',')[1], 'base64');
  
  console.log(`📥 [DOWNLOAD] ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB) from session "${sessionId}" by ${file.uploadedBy}`);
  
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
  res.send(buffer);
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
    isActive: session.users.size > 0
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

// Simple stats endpoint for quick check
app.get('/api/stats/simple', (req, res) => {
  const totalUsers = Array.from(sessions.values()).reduce((sum, s) => sum + s.users.size, 0);
  res.json({
    users: totalUsers,
    sessions: sessions.size,
    timestamp: new Date().toISOString()
  });
});

io.on('connection', (socket) => {
  console.log(`🔌 [CONNECT] New client connected: ${socket.id}`);
  logSessions();
  
  socket.on('create-session', ({ sessionId, username }, callback) => {
    console.log(`✨ [CREATE] Session request: "${sessionId}" by "${username}"`);
    
    if (!sessionId || sessionId.length < 2) {
      console.log(`❌ [CREATE] Failed - Invalid session name: "${sessionId}"`);
      callback({ success: false, error: 'Session name must be at least 2 characters' });
      return;
    }
    
    if (sessions.has(sessionId)) {
      console.log(`❌ [CREATE] Failed - Session "${sessionId}" already exists`);
      callback({ success: false, error: 'Session name already taken' });
      return;
    }
    
    const session = new Session(sessionId, username);
    sessions.set(sessionId, session);
    session.users.set(socket.id, { username, deviceType: 'creator' });
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.username = username;
    
    console.log(`✅ [CREATE] Session "${sessionId}" created by "${username}"`);
    console.log(`📊 [SESSION] "${sessionId}" now has ${session.users.size} user(s)`);
    logSessions();
    
    callback({ success: true, sessionId });
  });
  
  socket.on('join-session', ({ sessionId, username }, callback) => {
    console.log(`🚪 [JOIN] Request: "${username}" trying to join "${sessionId}"`);
    
    const session = sessions.get(sessionId);
    if (!session) {
      console.log(`❌ [JOIN] Failed - Session "${sessionId}" not found`);
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
      console.log(`❌ [JOIN] Failed - Username "${username}" already taken in "${sessionId}"`);
      callback({ success: false, error: `Username "${username}" already taken` });
      return;
    }
    
    session.users.set(socket.id, { username, deviceType: 'joiner' });
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.username = username;
    session.lastActivity = Date.now();
    
    console.log(`✅ [JOIN] "${username}" joined session "${sessionId}"`);
    console.log(`📊 [SESSION] "${sessionId}" now has ${session.users.size} user(s) (${Array.from(session.users.values()).map(u => u.username).join(', ')})`);
    
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
    
    logSessions();
    callback({ success: true, sessionId });
  });
  
  socket.on('send-message', ({ sessionId, message }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    
    const user = session.users.get(socket.id);
    if (!user) return;
    
    console.log(`💬 [MESSAGE] "${user.username}" in "${sessionId}": ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
    
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
    
    console.log(`📤 [UPLOAD] "${user.username}" uploading "${fileName}" (${(fileSize / 1024 / 1024).toFixed(2)} MB) to "${sessionId}"`);
    
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
    
    console.log(`✅ [UPLOAD] Complete: "${fileName}" to session "${sessionId}"`);
    logSessions();
    
    callback({ success: true });
  });
  
  socket.on('restore-history', ({ sessionId, history }) => {
    const session = sessions.get(sessionId);
    if (session && history) {
      console.log(`📜 [RESTORE] Restoring ${history.length} messages to session "${sessionId}" by "${socket.username}"`);
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
          console.log(`👋 [LEAVE] "${user.username}" leaving session "${socket.sessionId}"`);
          session.users.delete(socket.id);
          session.lastActivity = Date.now();
          socket.to(socket.sessionId).emit('user-left', {
            message: `${user.username} left the session`
          });
          console.log(`📊 [SESSION] "${socket.sessionId}" now has ${session.users.size} user(s)`);
          
          if (session.users.size === 0) {
            console.log(`⏰ [TIMER] Session "${socket.sessionId}" has no users. Will be deleted after 10 minutes of inactivity.`);
          }
        }
      }
      socket.leave(socket.sessionId);
      delete socket.sessionId;
    }
    logSessions();
  });
  
  socket.on('disconnect', () => {
    console.log(`🔌 [DISCONNECT] Client disconnected: ${socket.id} (${socket.username || 'unknown'})`);
    
    if (socket.sessionId) {
      const session = sessions.get(socket.sessionId);
      if (session) {
        const user = session.users.get(socket.id);
        if (user) {
          console.log(`👋 [DISCONNECT] "${user.username}" disconnected from session "${socket.sessionId}"`);
          session.users.delete(socket.id);
          socket.to(socket.sessionId).emit('user-left', {
            message: `${user.username} disconnected`
          });
          
          if (session.users.size === 0) {
            console.log(`⏰ [TIMER] Session "${socket.sessionId}" has no users. Will be deleted after 10 minutes.`);
          }
        }
      }
    }
    logSessions();
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
    }
  });
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(60));
  console.log(`🚀 FILE EXCHANGE SERVER RUNNING`);
  console.log('='.repeat(60));
  console.log(`📍 Port: ${PORT}`);
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`📍 Static files: ${publicPath}`);
  console.log(`📊 Stats endpoint: http://localhost:${PORT}/api/stats`);
  console.log(`💾 Memory monitoring active (logs every minute)`);
  console.log('='.repeat(60) + '\n');
});
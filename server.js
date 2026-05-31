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

// IMPORTANT: Use absolute path for serving static files
const publicPath = path.join(__dirname, 'public');
console.log('Serving static files from:', publicPath);

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
}

// Clean up old sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (session.users.size === 0 && now - session.lastActivity > 600000) {
      console.log(`Cleaning up inactive session: ${id}`);
      sessions.delete(id);
    }
  }
}, 60000);

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Download endpoint
app.get('/download/:sessionId/:fileId', (req, res) => {
  const { sessionId, fileId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session || !session.files.has(fileId)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  const file = session.files.get(fileId);
  const buffer = Buffer.from(file.data.split(',')[1], 'base64');
  
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
  res.send(buffer);
});

// API endpoint to check if session exists
app.get('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  res.json({ exists: !!session, userCount: session ? session.users.size : 0 });
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  socket.on('create-session', ({ sessionId, username }, callback) => {
    console.log(`Create session request: ${sessionId} by ${username}`);
    
    if (!sessionId || sessionId.length < 2) {
      callback({ success: false, error: 'Session name must be at least 2 characters' });
      return;
    }
    
    if (sessions.has(sessionId)) {
      callback({ success: false, error: 'Session name already taken. Please choose another.' });
      return;
    }
    
    const session = new Session(sessionId, username);
    sessions.set(sessionId, session);
    session.users.set(socket.id, { username, deviceType: 'creator' });
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.username = username;
    
    console.log(`Session created: ${sessionId} by ${username}`);
    console.log(`Active sessions: ${sessions.size}`);
    
    callback({ success: true, sessionId });
  });
  
  socket.on('join-session', ({ sessionId, username }, callback) => {
    console.log(`Join session request: ${sessionId} by ${username}`);
    
    const session = sessions.get(sessionId);
    if (!session) {
      callback({ success: false, error: `Session "${sessionId}" not found. Please check the name.` });
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
      callback({ success: false, error: `Username "${username}" is already taken in this session.` });
      return;
    }
    
    session.users.set(socket.id, { username, deviceType: 'joiner' });
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.username = username;
    session.lastActivity = Date.now();
    
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
    
    console.log(`${username} joined session ${sessionId}`);
    console.log(`Users in session: ${session.users.size}`);
    
    callback({ success: true, sessionId });
  });
  
  socket.on('send-message', ({ sessionId, message }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    
    const user = session.users.get(socket.id);
    if (!user) return;
    
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
    
    callback({ success: true });
    console.log(`File uploaded: ${fileName} by ${user.username} in ${sessionId}`);
  });
  
  socket.on('restore-history', ({ sessionId, history }) => {
    const session = sessions.get(sessionId);
    if (session && history) {
      session.messages = history;
      session.lastActivity = Date.now();
      console.log(`History restored for session ${sessionId}: ${history.length} messages`);
    }
  });
  
  socket.on('leave-session', () => {
    if (socket.sessionId) {
      const session = sessions.get(socket.sessionId);
      if (session) {
        const user = session.users.get(socket.id);
        if (user) {
          session.users.delete(socket.id);
          session.lastActivity = Date.now();
          socket.to(socket.sessionId).emit('user-left', {
            message: `${user.username} left the session`
          });
          console.log(`${user.username} left session ${socket.sessionId}`);
        }
      }
      socket.leave(socket.sessionId);
      delete socket.sessionId;
    }
  });
  
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    
    if (socket.sessionId) {
      const session = sessions.get(socket.sessionId);
      if (session) {
        const user = session.users.get(socket.id);
        if (user) {
          session.users.delete(socket.id);
          socket.to(socket.sessionId).emit('user-left', {
            message: `${user.username} disconnected`
          });
          console.log(`${user.username} disconnected from ${socket.sessionId}`);
        }
      }
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    sessions: sessions.size,
    users: Array.from(sessions.values()).reduce((sum, s) => sum + s.users.size, 0),
    staticPath: publicPath
  });
});

// Serve index.html for all other routes (MUST be last)
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server running!`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`📍 Static files: ${publicPath}`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`📍 http://${getLocalIp()}:${PORT}\n`);
});
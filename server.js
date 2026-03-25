const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const fileUpload = require('express-fileupload');
const qrcode = require('qrcode');
const os = require('os');
const { spawn } = require('child_process');

// Global Error Handling
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
  try {
    fs.appendFileSync('crash.log', `${new Date().toISOString()} - Uncaught Exception: ${err.stack}\n`);
  } catch (e) {}
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection:', reason);
  try {
    fs.appendFileSync('crash.log', `${new Date().toISOString()} - Unhandled Rejection: ${reason}\n`);
  } catch (e) {}
});

// Helper to get all files recursively
function getFiles(dir, baseDir = dir) {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const dirent of list) {
    const filePath = path.join(dir, dirent.name);
    const relativePath = path.relative(baseDir, filePath).replace(/\\/g, '/');
    if (dirent.isDirectory()) {
      results.push({ path: relativePath, name: dirent.name, type: 'directory' });
      results = results.concat(getFiles(filePath, baseDir));
    } else if (dirent.name.endsWith('.json')) {
      try {
        let testData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // Normalize if it's just an array of questions
        if (Array.isArray(testData)) {
          testData = { title: dirent.name.replace('.json', ''), questions: testData };
        }
        results.push({
          path: relativePath,
          name: dirent.name,
          type: 'file',
          data: testData
        });
      } catch (e) {
        try {
            fs.appendFileSync('server.log', `${new Date().toISOString()} - Error parsing JSON in ${filePath}: ${e}\n`);
        } catch (err) {}
      }
    }
  }
  return results;
}

function shuffleArray(array) {
  const newArr = [...array];
  for (let i = newArr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
  }
  return newArr;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Ensure necessary directories exist
['results', 'media', 'tests'].forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`[INIT] Created directory: ${dir}`);
    }
});

// Basic Authentication Middleware for Teacher Dashboard
const teacherAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic');
    return res.status(401).send('Потрібна авторизація');
  }
  const [user, pass] = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin123';
  if (user === 'admin' && pass === ADMIN_PASS) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic');
    return res.status(401).send('Невірний пароль');
  }
};

// GLOBAL CSP & CACHE OVERRIDE - MUST BE FIRST
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline';");
  next();
});

app.use(express.json());
app.use(fileUpload());
app.use('/shared.css', (req, res) => res.sendFile(path.join(__dirname, 'shared.css')));

// Protect teacher routes
app.use('/teacher', teacherAuth, express.static(path.join(__dirname, 'teacher')));
app.use('/api/tests', (req, res, next) => { if (req.method !== 'GET') return teacherAuth(req, res, next); next(); });
app.use('/api/folders', teacherAuth);
app.use('/api/results', teacherAuth);
app.use('/api/export-results', teacherAuth);

app.use('/student', express.static(path.join(__dirname, 'student')));
app.use('/media', express.static(path.join(__dirname, 'media')));

// Storage for active session data
const activeSessions = {}; // Maps PIN -> { id, pin, test, settings, path, students, fileName }
const saveTimeouts = {}; // Maps PIN -> timeoutId for debounced saving

const SESSIONS_FILE = path.join(__dirname, 'active_sessions.json');

function persistActiveSessions() {
    try {
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(activeSessions, null, 2));
    } catch (e) {
        console.error('[PERSISTENCE] Error saving sessions:', e);
    }
}

function loadPersistentSessions() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
            Object.assign(activeSessions, data);
            console.log(`[PERSISTENCE] Recovered ${Object.keys(activeSessions).length} sessions.`);
        }
    } catch (e) {
        console.error('[PERSISTENCE] Error loading sessions:', e);
    }
}

loadPersistentSessions();

// Socket.io Logic
io.on('connection', (socket) => {
  try {
    fs.appendFileSync('server.log', `${new Date().toISOString()} - User connected: ${socket.id}\n`);
  } catch (e) {}

  function broadcastSessions() {
      io.to('teacher_room').emit('sessions_list_update', Object.values(activeSessions).map(s => ({
          pin: s.pin, title: s.test.title, studentCount: s.students.length
      })));
  }

  socket.on('teacher_join', () => {
    socket.join('teacher_room');
    broadcastSessions();
    // Also provide initial server info immediately
    socket.emit('init_state', { 
        activeTest: null, 
        students: [], 
        pin: null,
        sessionsCount: Object.keys(activeSessions).length 
    });
  });

  socket.on('teacher_view_session', (pin) => {
      const session = activeSessions[pin];
      if (session) {
          socket.emit('init_state', { activeTest: session.test, students: session.students, pin });
      }
  });

  // Helper for socket events
  function findStudentSession(socketId) {
      for (const pin in activeSessions) {
          const student = activeSessions[pin].students.find(s => s.id === socketId);
          if (student) return { session: activeSessions[pin], student };
      }
      return { session: null, student: null };
  }

  socket.on('student_join', (data) => {
    try {
        if (!data) throw new Error('No data received in student_join');
        const pin = data.pin;
        if (!pin) {
            return socket.emit('join_error', 'Будь ласка, введіть PIN-код.');
        }

        if (!activeSessions[pin]) {
            return socket.emit('join_error', 'Невірний PIN-код або тест не знайдено!');
        }
        
        const session = activeSessions[pin];
        if (!session.students) session.students = [];
        
        const activeTest = session.test;
        if (!activeTest || !Array.isArray(activeTest.questions)) {
            console.error(`ERROR: Test for session ${pin} has no questions!`, activeTest);
            return socket.emit('join_error', 'Помилка завантаження тесту: немає питань.');
        }
        
        let studentQuestions = [...activeTest.questions];
        
        // Randomization Logic
        if (session.settings) {
          if (session.settings.shuffleQuestions || session.settings.pickCount) {
            studentQuestions = shuffleArray(studentQuestions);
          }
          if (session.settings.shuffleAnswers) {
            studentQuestions = studentQuestions.map(q => {
              if (q.options && Array.isArray(q.options)) {
                return { ...q, options: shuffleArray(q.options) };
              }
              return q;
            });
          }
          if (session.settings.pickCount && session.settings.pickCount < studentQuestions.length) {
              studentQuestions = studentQuestions.slice(0, session.settings.pickCount);
          }
        }

        // Check if student with this name already exists in this session
        let student = session.students.find(s => s && s.name === data.name);
        
        if (student) {
            // Re-joining existing student: update socket ID and questions
            student.id = socket.id;
            student.status = 'online';
            if (!student.startTime) student.startTime = Date.now();
            student.questions = studentQuestions; // Refresh questions on join
        } else {
            // New student
            student = { 
              id: socket.id, 
              token: data.token,
              name: data.name, 
              answers: {}, 
              violations: [], 
              score: 0, 
              status: 'online',
              questions: studentQuestions,
              results: {},
              startTime: Date.now(),
              endTime: null
            };
            session.students.push(student);
        }
        
        socket.join(`session_${pin}`);
        io.to('teacher_room').emit('student_update', { pin: pin, students: session.students });
        socket.emit('start_test', { ...activeTest, questions: student.questions });

        fs.appendFileSync('server.log', `${new Date().toISOString()} - Student ${data.name} joined session ${pin}\n`);

    } catch (e) {
        const errLog = `${new Date().toISOString()} - CRITICAL Error in student_join: ${e.stack || e}\n`;
        console.error(errLog);
        try { fs.appendFileSync('server.log', errLog); } catch (err) {}
        socket.emit('join_error', 'Помилка на сервері при спробі входу. Спробуйте ще раз.');
    }
  });

  socket.on('submit_answer', (data) => {
    const { session, student } = findStudentSession(socket.id);
    if (student && session && session.test) {
      const q = session.test.questions.find(q => q.id === data.questionId);
      if (!q) return;

      const isViolated = student.violations.includes(data.questionId);
      const isCorrect = checkCorrectness(data.answer, q.answer);
      const scoreWeight = q.score || 1;
      
      student.answers[data.questionId] = {
        answer: data.answer,
        isViolated: isViolated
      };
      
      student.results[data.questionId] = {
        isCorrect: isViolated ? false : isCorrect,
        answer: data.answer,
        isViolated: isViolated,
        score: isViolated ? 0 : (isCorrect ? scoreWeight : 0)
      };

      // Recalculate total score
      let totalScore = 0;
      Object.keys(student.results).forEach(qId => {
        totalScore += student.results[qId].score || 0;
      });
      student.score = Math.round(totalScore * 100) / 100;
      
      if (Object.keys(student.results).length === student.questions.length) {
          student.endTime = Date.now();
          autoSaveSession(session.pin);
          persistActiveSessions(); // Ensure state is saved when someone finishes
      } else {
          // Debounced save for progress
          if (saveTimeouts[session.pin]) clearTimeout(saveTimeouts[session.pin]);
          saveTimeouts[session.pin] = setTimeout(() => {
              autoSaveSession(session.pin);
              persistActiveSessions();
              delete saveTimeouts[session.pin];
          }, 5000); 
      }

      io.to('teacher_room').emit('student_update', { pin: session.pin, students: session.students });
    }
  });

function checkCorrectness(provided, actual) {
    if (Array.isArray(actual)) {
        if (!Array.isArray(provided)) return false;
        return actual.length === provided.length && actual.every(v => provided.includes(v));
    }
    if (typeof actual === 'object' && actual !== null) {
        if (typeof provided !== 'object' || provided === null) return false;
        const keys = Object.keys(actual);
        if (keys.length !== Object.keys(provided).length) return false;
        return keys.every(k => checkCorrectness(provided[k], actual[k]));
    }
    const pStr = String(provided).trim().toLowerCase().replace(',', '.');
    const aStr = String(actual).trim().toLowerCase().replace(',', '.');
    return pStr === aStr;
}

  socket.on('cheat_warning', (data) => {
    const { session, student } = findStudentSession(socket.id);
    if (student && data.questionId && session) {
      if (!student.violations.includes(data.questionId)) {
        student.violations.push(data.questionId);
        
        if (student.violations.length >= 3) {
            student.status = 'disqualified';
            student.score = 0; // Annul score
            socket.emit('test_locked', 'Тест заблоковано через часті спроби списування (вихід за межі тесту 3+ рази)!');
            autoSaveSession(session.pin);
        }
        
        io.to('teacher_room').emit('student_update', { pin: session.pin, students: session.students });
        try {
            fs.appendFileSync('server.log', `${new Date().toISOString()} - Student ${student.name} warned for cheating on question ${data.questionId}. Total violations: ${student.violations.length}\n`);
        } catch (e) {}
      }
    }
  });

  socket.on('cheat_detected', () => {
    const { session, student } = findStudentSession(socket.id);
    if (student && session) {
      student.status = 'disqualified';
      student.score = 0;
      autoSaveSession(session.pin);
      io.to('teacher_room').emit('student_update', { pin: session.pin, students: session.students });
    }
  });

  socket.on('start_test_broadcast', (data) => {
    let pin = data.settings.pin;
    if (!pin) {
        pin = Math.floor(1000 + Math.random() * 9000).toString();
        data.settings.pin = pin;
    }
    
    const sessionId = Date.now().toString(36).toUpperCase();
    const testName = data.test.title ? data.test.title.replace(/[^a-z0-9а-яіїєґ]/gi, '_') : 'Unnamed';
    const fileName = `${testName}_${pin}.json`;

    let existingStudents = [];
    const resultsDir = path.join(__dirname, 'results');
    const filePath = path.join(resultsDir, fileName);
    if (fs.existsSync(filePath)) {
        try {
            const savedData = JSON.parse(fs.readFileSync(filePath));
            if (savedData.students) {
                existingStudents = savedData.students;
                existingStudents.forEach(s => s.status = 'offline');
            }
        } catch(e) {}
    }

    activeSessions[pin] = {
        id: sessionId, pin: pin, test: data.test, path: data.path,
        settings: data.settings, students: existingStudents, fileName: fileName
    };
    
    persistActiveSessions();
    broadcastSessions();
  });

  socket.on('stop_test_broadcast', (pin) => {
    console.log(`[SESSION] Stop request received for PIN: ${pin}`);
    if (!pin || !activeSessions[pin]) {
        console.log(`[SESSION] Stop aborted: Session ${pin} not found or invalid PIN.`);
        return;
    }
    
    try {
        if (saveTimeouts[pin]) clearTimeout(saveTimeouts[pin]);
        autoSaveSession(pin);
        io.to(`session_${pin}`).emit('stop_test');
        console.log(`[SESSION] Stop event emitted to room session_${pin}`);
        
        delete activeSessions[pin];
        delete saveTimeouts[pin];
        persistActiveSessions();
        broadcastSessions();
        console.log(`[SESSION] Session ${pin} successfully removed from active list.`);
    } catch (err) {
        console.error(`[SESSION] ERROR during stop_test_broadcast for ${pin}:`, err);
    }
  });

  socket.on('finish_test', () => {
    const { session, student } = findStudentSession(socket.id);
    if (student && session) {
        student.endTime = Date.now();
        autoSaveSession(session.pin);
        socket.emit('test_results', { score: student.score });
        io.to('teacher_room').emit('student_update', { pin: session.pin, students: session.students });
    }
  });

  socket.on('disconnect', () => {
    const { session, student } = findStudentSession(socket.id);
    if (student && session) {
      student.status = 'offline';
      io.to('teacher_room').emit('student_update', { pin: session.pin, students: session.students });
    }
  });
});

function autoSaveSession(pin) {
  const session = activeSessions[pin];
  if (!session || !session.test || session.students.length === 0) return;
  
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir);
  
  const sessionData = {
    test: session.test,
    path: session.path,
    sessionId: session.id,
    pin: session.pin,
    students: session.students,
    timestamp: new Date().toISOString()
  };
  
  fs.writeFileSync(path.join(resultsDir, session.fileName), JSON.stringify(sessionData, null, 2));
  
  // Save to students_db.json
  try {
      const dbPath = path.join(__dirname, 'students_db.json');
      let db = {};
      if (fs.existsSync(dbPath)) db = JSON.parse(fs.readFileSync(dbPath));
      
      session.students.forEach(s => {
          if (!s.token) return;
          if (!db[s.token]) db[s.token] = { name: s.name, history: [] };
          db[s.token].name = s.name;
          const testTitle = session.test.title || 'test';
          const existingRun = db[s.token].history.find(h => h.testSessionId === session.id);
          if (existingRun) {
              existingRun.score = s.score;
              existingRun.date = new Date().toISOString();
          } else {
              db[s.token].history.push({
                  testTitle: testTitle,
                  testSessionId: session.id,
                  score: s.score,
                  date: new Date().toISOString()
              });
          }
      });
      fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  } catch (err) {}
}

// API for Student History
app.get('/api/student/history', (req, res) => {
    const token = req.query.token;
    if (!token) return res.json([]);
    try {
        const dbPath = path.join(__dirname, 'students_db.json');
        if (!fs.existsSync(dbPath)) return res.json([]);
        const db = JSON.parse(fs.readFileSync(dbPath));
        if (db[token] && db[token].history) {
            res.json(db[token].history);
        } else {
            res.json([]);
        }
    } catch(err) {
        res.json([]);
    }
});

// API for Tests Management
app.post('/api/tests/folder', (req, res) => {
    try {
        const folderName = req.body.folder;
        if (!folderName) return res.status(400).json({ error: 'Folder name is required' });
        
        // Anti-directory traversal protection
        const cleanName = folderName.replace(/\.\./g, '');
        const targetDir = path.join(testsDir, cleanName);
        
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/tests', (req, res) => {
  try {
    const testsDir = path.join(__dirname, 'tests');
    if (!fs.existsSync(testsDir)) fs.mkdirSync(testsDir);
    const tests = getFiles(testsDir);
    console.log(`[API] Serving ${tests.length} tests/folders from ${testsDir}`);
    res.json(tests);
  } catch (err) {
    try {
        fs.appendFileSync('server.log', `${new Date().toISOString()} - API Error /api/tests: ${err}\n`);
    } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/folders', (req, res) => {
  const folderPath = path.join(__dirname, 'tests', req.body.path);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
    res.sendStatus(200);
  } else {
    res.status(400).send('Folder already exists');
  }
});

app.post('/api/folders/rename', (req, res) => {
  const oldPath = path.join(__dirname, 'tests', req.body.oldPath);
  const newPath = path.join(__dirname, 'tests', req.body.newPath);
  if (fs.existsSync(oldPath)) {
    fs.renameSync(oldPath, newPath);
    res.sendStatus(200);
  } else {
    res.status(404).send('Folder not found');
  }
});

app.post('/api/tests', (req, res) => {
  const testsDir = path.join(__dirname, 'tests', req.body.folder || '');
  if (!fs.existsSync(testsDir)) fs.mkdirSync(testsDir, { recursive: true });
  const fileName = `${req.body.title.replace(/\s+/g, '_')}.json`;
  fs.writeFileSync(path.join(testsDir, fileName), JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.get('/api/server-info', async (req, res) => {
  try {
    // Get Local IP
    const nets = os.networkInterfaces();
    const addresses = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          addresses.push(net.address);
        }
      }
    }
    const localIp = addresses[0] || 'localhost';
    
    // Get Public IP (for localtunnel password)
    let publicIp = 'unknown';
    try {
        const ipRes = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipRes.json();
        publicIp = ipData.ip;
    } catch (e) {
        try {
            fs.appendFileSync('server.log', `${new Date().toISOString()} - Failed to get public IP: ${e}\n`);
        } catch (err) {}
    }
    const localUrl = `http://${localIp}:${PORT}/student`;
    let joinUrl = localUrl;
    
    if (process.env.RENDER_EXTERNAL_URL) {
        joinUrl = `${process.env.RENDER_EXTERNAL_URL}/student`;
    } else if (process.env.SYNC_MASTER_URL) {
        joinUrl = `${process.env.SYNC_MASTER_URL}/student`;
    } else if (process.env.PUBLIC_URL) {
        joinUrl = `${process.env.PUBLIC_URL}/student`;
    }
    
    const qrCodeData = await qrcode.toDataURL(joinUrl);

    res.json({
      localIp,
      publicIp,
      localUrl,
      publicUrl: process.env.PUBLIC_URL || null,
      joinUrl,
      qrCodeData,
      port: PORT
    });
  } catch (err) {
    try {
        fs.appendFileSync('server.log', `${new Date().toISOString()} - API Error /api/server-info: ${err}\n`);
    } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/results-data/:name', (req, res) => {
  const filePath = path.join(__dirname, 'results', req.params.name);
  if (fs.existsSync(filePath)) {
    res.json(JSON.parse(fs.readFileSync(filePath)));
  } else {
    res.status(404).send('Result not found');
  }
});

app.get('/api/export-results', (req, res) => {
  const pin = req.query.pin;
  const filename = req.query.filename;
  let sessionData = null;

  if (pin && activeSessions[pin]) {
    const session = activeSessions[pin];
    sessionData = {
      test: session.test,
      students: session.students,
      pin: session.pin
    };
  } else if (filename) {
    const filePath = path.join(__dirname, 'results', filename.replace(/\.\./g, ''));
    if (fs.existsSync(filePath)) {
      sessionData = JSON.parse(fs.readFileSync(filePath));
    }
  }

  if (!sessionData || !sessionData.students || sessionData.students.length === 0) {
    return res.status(400).send('No data to export');
  }
  
  const activeTest = sessionData.test;
  const students = sessionData.students;
  const exportPin = sessionData.pin || 'archived';

  const totalPossibleScore = activeTest ? activeTest.questions.reduce((sum, q) => sum + (q.score || 1), 0) : 1;
  const totalQuestions = activeTest ? activeTest.questions.length : 0;
  
  // Sort students by score for ranking
  const sortedStudents = [...students].sort((a, b) => b.score - a.score);
  
  let csv = '№з/п;Рейтинг в сесії;ПІБ/ПІМ учня;Кількість правильних відповідей;Кількість неправильних відповідей;Оцінка за 12 бальною шкалою;кількість питань без відповіді;Статус пройдено до кінця/незавершив;час витрачений на тест;кількість відповідей з виходом за межі тесту;Дата проведення\n';
  
  students.forEach((s, index) => {
    const rank = sortedStudents.findIndex(ss => ss.name === s.name) + 1;
    const correctCount = s.results ? Object.values(s.results).filter(r => r.isCorrect).length : 0;
    const skippedCount = s.results ? Object.values(s.results).filter(r => r.answer === 'ПРОПУЩЕНО').length : 0;
    const incorrectCount = totalQuestions - correctCount - skippedCount;
    
    // 12-point grade calculation
    const grade12 = Math.round((s.score / totalPossibleScore) * 12);
    
    // Time spent
    const endTime = s.endTime || Date.now();
    const durationMs = endTime - (s.startTime || Date.now());
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);
    const timeSpent = `${minutes}хв ${seconds}с`;
    
    const dateStr = new Date().toLocaleDateString('uk-UA');
    const statusStr = s.endTime ? 'Пройдено' : 'Незавершено';

    csv += `${index + 1};${rank};"${s.name}";${correctCount};${incorrectCount};${grade12};${skippedCount};${statusStr};${timeSpent};${s.violations.length};${dateStr}\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=results_${exportPin}.csv`);
  res.send('\uFEFF' + csv);
});

app.get('/api/results', (req, res) => {
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) return res.json([]);
  const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json'));
  res.json(files.map(f => ({ name: f, path: f })));
});

app.get('/api/results/:name', (req, res) => {
  const filePath = path.join(__dirname, 'results', req.params.name);
  if (fs.existsSync(filePath)) {
    res.json(JSON.parse(fs.readFileSync(filePath)));
  } else {
    res.status(404).send('Result not found');
  }
});

app.delete('/api/results/:name', (req, res) => {
  const filePath = path.join(__dirname, 'results', req.params.name);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    res.sendStatus(200);
  } else {
    res.status(404).send('Result not found');
  }
});

app.delete(/^\/api\/tests\/(.*)/, (req, res) => {
  const testPath = req.params[0];
  const filePath = path.join(__dirname, 'tests', testPath);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    res.sendStatus(200);
  } else {
    res.status(404).send('Test not found');
  }
});

// Initialize P2P Synchronization
require('./sync')(io);

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  try {
    fs.appendFileSync('server.log', `${new Date().toISOString()} - Server running on http://localhost:${PORT}\n`);
  } catch (e) {}

    // Automated Cloudflare Tunnel startup (Skip in Cloud Environment)
    if (process.env.RENDER || process.env.RAILWAY_STATIC_URL) {
        console.log('Running on Cloud Hosting. Cloudflare local tunnel skipped.');
        return;
    }

    try {
        const cfLog = path.join(__dirname, 'cloudflare_output.txt');
        if (fs.existsSync(cfLog)) fs.unlinkSync(cfLog);

        const cfExe = path.join(__dirname, 'cloudflared.exe');
        if (!fs.existsSync(cfExe)) return;

        const cf = spawn(cfExe, [
        'tunnel', 
        '--url', 'http://localhost:' + PORT
    ]);

    const handleOutput = (data) => {
        const output = data.toString();
        fs.appendFileSync(cfLog, output);
        const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
            const url = match[0];
            process.env.PUBLIC_URL = url;
            console.log('--------------------------------------------------');
            console.log('🚀 ТУНЕЛЬ CLOUDFLARE ЗАПУЩЕНО!');
            console.log(`🔗 Посилання для студентів: ${url}/student`);
            console.log('--------------------------------------------------');
        }
    };

    cf.stdout.on('data', handleOutput);
    cf.stderr.on('data', handleOutput); // URL is usually in stderr

    cf.on('close', (code) => {
        console.log(`Cloudflare tunnel closed (code ${code})`);
    });

    // Get Public IP for reference (optional)
    try {
        const ipRes = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipRes.json();
        console.log(`🌍 Ваш публічний IP: ${ipData.ip}`);
    } catch (e) {}

  } catch (err) {
    console.error('Failed to start Cloudflare Tunnel:', err);
  }
});

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
  fs.appendFileSync('crash.log', `${new Date().toISOString()} - Uncaught Exception: ${err.stack}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  fs.appendFileSync('crash.log', `${new Date().toISOString()} - Unhandled Rejection: ${reason}\n`);
});

// Helper to get all files recursively
function getFiles(dir, baseDir = dir) {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  list.forEach(dirent => {
    const filePath = path.join(dir, dirent.name);
    const relativePath = path.relative(baseDir, filePath).replace(/\\/g, '/');
    if (dirent.isDirectory()) {
      results.push({ path: relativePath, name: dirent.name, type: 'directory' });
      results = results.concat(getFiles(filePath, baseDir));
    } else if (dirent.name.endsWith('.json')) {
      try {
        results.push({
          path: relativePath,
          name: dirent.name,
          type: 'file',
          data: JSON.parse(fs.readFileSync(filePath))
        });
      } catch (e) {
        try {
            fs.appendFileSync('server.log', `${new Date().toISOString()} - Error parsing JSON in ${filePath}: ${e}\n`);
        } catch (err) {}
      }
    }
  });
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
let activeTest = null;
let activeTestPath = null;
let currentSessionId = null;
let students = []; // { id, name, answers, status, sessionId }

// Socket.io Logic
io.on('connection', (socket) => {
  try {
    fs.appendFileSync('server.log', `${new Date().toISOString()} - User connected: ${socket.id}\n`);
  } catch (e) {}

  socket.on('teacher_join', () => {
    socket.join('teacher_room');
    socket.emit('init_state', { activeTest, students });
  });

  socket.on('student_join', (data) => {
    try {
        // PIN Validation
        if (activeTest && activeTest.settings && activeTest.settings.pin) {
            if (data.pin !== activeTest.settings.pin) {
                return socket.emit('join_error', 'Невірний PIN-код!');
            }
        }

        let studentQuestions = activeTest ? [...activeTest.questions] : [];
        
        // Randomization Logic
        if (activeTest && activeTest.settings) {
          if (activeTest.settings.shuffleQuestions || activeTest.settings.pickCount) {
            studentQuestions = shuffleArray(studentQuestions);
          }
          if (activeTest.settings.shuffleAnswers) {
            studentQuestions = studentQuestions.map(q => {
              if (q.options && Array.isArray(q.options)) {
                return { ...q, options: shuffleArray(q.options) };
              }
              return q;
            });
          }
          if (activeTest.settings.pickCount && activeTest.settings.pickCount < studentQuestions.length) {
              studentQuestions = studentQuestions.slice(0, activeTest.settings.pickCount);
          }
        }

        // Check if student with this name already exists in this session
        let student = students.find(s => s.name === data.name);
        
        if (student) {
            // Re-joining existing student: update socket ID and questions
            student.id = socket.id;
            student.status = 'online';
            if (!student.startTime) student.startTime = Date.now();
            if (activeTest) {
                // If test is active, ensure they have the latest questions
                student.questions = studentQuestions;
            }
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
            students.push(student);
        }
        
        socket.join('student_room');
        io.to('teacher_room').emit('student_update', students);
        
        if (activeTest) {
          socket.emit('start_test', { ...activeTest, questions: student.questions });
        }
    } catch (e) {
        try {
            fs.appendFileSync('server.log', `${new Date().toISOString()} - Error in student_join: ${e}\n`);
        } catch (err) {}
        socket.emit('join_error', 'Помилка на сервері при спробі входу.');
    }
  });

  socket.on('submit_answer', (data) => {
    const student = students.find(s => s.id === socket.id);
    if (student && activeTest) {
      const q = activeTest.questions.find(q => q.id === data.questionId);
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

      io.to('teacher_room').emit('student_update', students);
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
    const student = students.find(s => s.id === socket.id);
    if (student && data.questionId) {
      if (!student.violations.includes(data.questionId)) {
        student.violations.push(data.questionId);
        
        if (student.violations.length >= 3) {
            student.status = 'disqualified';
            student.score = 0; // Annul score
            socket.emit('test_locked', 'Тест заблоковано через часті спроби списування (вихід за межі тесту 3+ рази)!');
        }
        
        io.to('teacher_room').emit('student_update', students);
        try {
            fs.appendFileSync('server.log', `${new Date().toISOString()} - Student ${student.name} warned for cheating on question ${data.questionId}. Total violations: ${student.violations.length}\n`);
        } catch (e) {}
      }
    }
  });

  socket.on('cheat_detected', () => {
    // Legacy support or fallback
    const student = students.find(s => s.id === socket.id);
    if (student) {
      student.status = 'disqualified';
      student.score = 1;
      io.to('teacher_room').emit('student_update', students);
    }
  });

  socket.on('start_test_broadcast', (data) => {
    activeTest = { ...data.test, settings: data.settings };
    activeTestPath = data.path;
    currentSessionId = Date.now().toString(36).toUpperCase(); // Unique session ID
    
    // Clear students for new session
    students = []; 
    
    io.to('student_room').emit('start_test', activeTest);
    try {
        fs.appendFileSync('server.log', `${new Date().toISOString()} - Test started: ${data.path} Session: ${currentSessionId}\n`);
    } catch (e) {}
  });

  socket.on('stop_test_broadcast', () => {
    saveResults();
    activeTest = null;
    activeTestPath = null;
    io.to('student_room').emit('stop_test');
  });

  socket.on('finish_test', () => {
    let student = students.find(s => s.id === socket.id);
    if (student) {
        student.endTime = Date.now();
        io.to('teacher_room').emit('student_update', students);
    }
  });

  socket.on('disconnect', () => {
    const student = students.find(s => s.id === socket.id);
    if (student) {
      student.status = 'offline';
      io.to('teacher_room').emit('student_update', students);
    }
  });
});

function saveResults() {
  if (!activeTest || students.length === 0) return;
  
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir);
  
  const testName = activeTestPath ? activeTestPath.split('/').pop().replace('.json', '') : 'Unnamed';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${testName}_${currentSessionId || 'NO_SESSION'}_${timestamp}.json`;
  
  const sessionData = {
    test: activeTest,
    path: activeTestPath,
    sessionId: currentSessionId,
    students: students,
    timestamp: new Date().toISOString()
  };
  
  fs.writeFileSync(path.join(resultsDir, fileName), JSON.stringify(sessionData, null, 2));
  
  // Save to students_db.json
  try {
      const dbPath = path.join(__dirname, 'students_db.json');
      let db = {};
      if (fs.existsSync(dbPath)) db = JSON.parse(fs.readFileSync(dbPath));
      
      students.forEach(s => {
          if (!s.token) return;
          if (!db[s.token]) db[s.token] = { name: s.name, history: [] };
          db[s.token].name = s.name;
          db[s.token].history.push({
              testTitle: activeTest.title || testName,
              score: s.score,
              date: new Date().toISOString()
          });
      });
      fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  } catch (err) {
      try { fs.appendFileSync('server.log', `${new Date().toISOString()} - Error saving students_db: ${err}\n`); } catch(e){}
  }

  try {
    fs.appendFileSync('server.log', `${new Date().toISOString()} - Results saved for session ${currentSessionId}: ${fileName}\n`);
  } catch (e) {}
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

app.get('/api/export-results', (req, res) => {
  if (students.length === 0) return res.status(400).send('No students to export');
  
  const totalPossibleScore = activeTest ? activeTest.questions.reduce((sum, q) => sum + (q.score || 1), 0) : 1;
  const totalQuestions = activeTest ? activeTest.questions.length : 0;
  
  // Sort students by score for ranking
  const sortedStudents = [...students].sort((a, b) => b.score - a.score);
  
  let csv = '№з/п;Рейтинг в сесії;ПІБ/ПІМ учня;Кількість правильних відповідей;Кількість неправильних відповідей;Оцінка за 12 бальною шкалою;кількість питань без відповіді;Статус пройдено до кінця/незавершив;час витрачений на тест;кількість відповідей з виходом за межі тесту;Дата проведення\n';
  
  students.forEach((s, index) => {
    const rank = sortedStudents.findIndex(ss => ss.name === s.name) + 1;
    const correctCount = Object.values(s.results).filter(r => r.isCorrect).length;
    const skippedCount = Object.values(s.results).filter(r => r.answer === 'ПРОПУЩЕНО').length;
    const incorrectCount = totalQuestions - correctCount - skippedCount;
    
    // 12-point grade calculation
    const grade12 = Math.round((s.score / totalPossibleScore) * 12);
    
    // Time spent
    const endTime = s.endTime || Date.now();
    const durationMs = endTime - s.startTime;
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);
    const timeSpent = `${minutes}хв ${seconds}с`;
    
    const dateStr = new Date().toLocaleDateString('uk-UA');
    const statusStr = s.endTime ? 'Пройдено' : 'Незавершено';

    csv += `${index + 1};${rank};"${s.name}";${correctCount};${incorrectCount};${grade12};${skippedCount};${statusStr};${timeSpent};${s.violations.length};${dateStr}\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=results.csv');
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

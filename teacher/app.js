window.onerror = (msg, url, line, col, error) => {
    const errText = `❌ Error: ${msg} at ${line}:${col}`;
    console.error(errText, error);
    const status = document.getElementById('connection-status');
    if (status) {
        status.innerText = errText;
        status.style.color = '#ff4444';
        status.style.fontWeight = 'bold';
    }
    return false;
};

// Globals
let socket;
let tests = [];
let questions = [];
let activeTest = null;
let currentPath = '';
let editingTest = null;
let currentTestToStart = null;
let analyticsChart = null;

// DOM Elements
let testList, breadcrumbs, listSection, createSection, activeSection, archiveSection, resultsList, builder;

document.addEventListener('DOMContentLoaded', () => {
    console.log('Dashboard Initializing...');
    
    // Initialize DOM references
    testList = document.getElementById('test-list');
    breadcrumbs = document.getElementById('breadcrumbs');
    listSection = document.getElementById('test-list-section');
    createSection = document.getElementById('create-test-section');
    activeSection = document.getElementById('active-session-section');
    archiveSection = document.getElementById('results-archive-section');
    resultsList = document.getElementById('results-list');
    builder = document.getElementById('questions-builder');

    // Socket Initialization
    socket = io();

    socket.on('connect', () => {
        document.getElementById('connection-status').innerText = '✅ Онлайн';
        socket.emit('teacher_join');
    });

    socket.on('connect_error', (err) => {
        document.getElementById('connection-status').innerText = '❌ Помилка з\'єднання';
    });

    socket.on('init_state', (data) => {
        refreshTests();
        updateServerInfo();
        if (data.activeTest) {
            activeTest = data.activeTest;
            showActiveSession(data.activeTest);
        }
        if (data.students) {
            updateProgressGrid(data.students);
            updateAnalyticsChart(data.students, activeTest ? activeTest.questions : []);
        }
    });

    socket.on('student_update', (students) => {
        updateProgressGrid(students);
        updateAnalyticsChart(students, activeTest ? activeTest.questions : []);
    });
    
    // Initial Load
    refreshTests();
    attachListeners();

    // Add UI Buttons
    const aiBtn = document.createElement('button');
    aiBtn.innerText = '🤖 ШІ Генератор';
    aiBtn.style.backgroundColor = 'var(--primary)';
    aiBtn.onclick = () => window.openAiGenerator();
    
    const importBtn = document.createElement('button');
    importBtn.innerText = '📂 Імпорт';
    importBtn.style.backgroundColor = '#10b981';
    importBtn.style.marginLeft = '10px';
    importBtn.onclick = async () => {
        const list = tests.filter(t => t.data).map(t => t.path);
        const path = prompt('Шлях:\n' + list.join('\n'));
        if (!path) return;
        const target = tests.find(t => t.path === path);
        if (target && target.data) { questions = questions.concat(JSON.parse(JSON.stringify(target.data.questions))); renderBuilder(); }
    };

    if (builder) {
        builder.parentNode.insertBefore(aiBtn, builder);
        builder.parentNode.insertBefore(importBtn, builder);
    }
});

async function updateServerInfo() {
    try {
        const res = await fetch('/api/server-info');
        const info = await res.json();
        document.getElementById('join-link').innerText = info.joinUrl;
        document.getElementById('join-link').href = info.joinUrl;
        const qrImg = document.getElementById('qrcode-img');
        qrImg.src = info.qrCodeData;
        qrImg.onclick = () => {
            document.getElementById('qr-modal-img').src = info.qrCodeData;
            document.getElementById('qr-modal').style.display = 'flex';
        };
        if (info.publicIp && !info.joinUrl.includes('trycloudflare.com')) {
            document.getElementById('tunnel-password-info').innerText = `Пароль: ${info.publicIp}`;
            document.getElementById('tunnel-password-info').classList.remove('hidden');
        }
    } catch (e) {}
}

function updateProgressGrid(students) {
    document.getElementById('student-count').innerText = students.length;
    const grid = document.getElementById('students-progress-grid');
    if (!grid) return;
    grid.innerHTML = students.map(s => {
        let statusColor = s.status === 'offline' ? 'var(--error)' : 'var(--success)';
        const testQCount = (activeTest && activeTest.questions) ? activeTest.questions.length : 0;
        let progressHtml = '';
        for (let i = 0; i < testQCount; i++) {
            const res = s.results[activeTest.questions[i].id];
            let color = res ? (res.isCorrect ? 'var(--success)' : 'var(--error)') : '#eee';
            progressHtml += `<div style="width:15px;height:15px;background:${color};border-radius:3px;"></div>`;
        }
        return `<div class="card" style="display:flex;justify-content:space-between;border-left:5px solid ${statusColor};">
            <div><strong>${s.name}</strong><div style="display:flex;gap:3px;margin-top:5px;">${progressHtml}</div></div>
            <div style="text-align:right;"><strong>${s.score}</strong></div>
        </div>`;
    }).join('');
}

async function refreshTests() {
    const res = await fetch('/api/tests');
    const data = await res.json();
    tests = Array.isArray(data) ? data : [];
    renderTestList();
}

window.navigateTo = (path) => { currentPath = path; renderTestList(); };

function renderTestList() {
    if (!testList || !breadcrumbs) return;
    breadcrumbs.innerHTML = `<span onclick="navigateTo('')" style="cursor:pointer">root</span> / ${currentPath}`;
    const items = tests.filter(t => {
        const dir = t.path.includes('/') ? t.path.substring(0, t.path.lastIndexOf('/')) : '';
        return dir === currentPath;
    });
    testList.innerHTML = items.map(t => `
        <div class="card" style="display:flex;justify-content:space-between;align-items:center;">
            <div onclick="${t.type==='directory' ? `navigateTo('${t.path}')` : ''}" style="cursor:pointer;flex:1;">
                ${t.type==='directory' ? '📁' : '📄'} ${t.name}
            </div>
            ${t.type==='file' ? `<div>
                <button onclick="startTest('${t.path}')" style="background:var(--success);">Запуск</button>
                <button onclick="editTest('${t.path}')" style="background:var(--primary);">Ред.</button>
                <button onclick="deleteTest('${t.path}')" style="background:var(--error);">X</button>
            </div>` : ''}
        </div>
    `).join('');
}

window.startTest = (path) => {
    currentTestToStart = tests.find(t => t.path === path);
    listSection.classList.add('hidden');
    document.getElementById('test-settings-section').classList.remove('hidden');
};

window.editTest = (path) => {
    const t = tests.find(x => x.path === path);
    if (!t) return;
    document.getElementById('test-title').value = t.data.title;
    questions = JSON.parse(JSON.stringify(t.data.questions));
    listSection.classList.add('hidden');
    createSection.classList.remove('hidden');
    renderBuilder();
};

window.deleteTest = async (path) => {
    if (confirm('Видалити?')) { await fetch(`/api/tests/${path}`, { method: 'DELETE' }); refreshTests(); }
};

function attachListeners() {
    const btn = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    btn('create-btn', () => { listSection.classList.add('hidden'); createSection.classList.remove('hidden'); questions = []; renderBuilder(); });
    btn('add-q-btn', () => { questions.push({ id: Date.now(), type: 'single', text: '', options: ['', ''], answer: '', score: 1 }); renderBuilder(); });
    btn('save-test-btn', async () => {
        const title = document.getElementById('test-title').value;
        await fetch('/api/tests', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ title, questions, folder: currentPath }) });
        createSection.classList.add('hidden'); listSection.classList.remove('hidden'); refreshTests();
    });
    btn('cancel-create-btn', () => { createSection.classList.add('hidden'); listSection.classList.remove('hidden'); });
    btn('start-with-settings-btn', () => {
        const settings = { 
            pin: document.getElementById('test-pin').value || null,
            pickCount: parseInt(document.getElementById('test-pick-count').value) || null,
            timerType: document.getElementById('timer-type').value,
            timerValue: parseInt(document.getElementById('timer-value').value) || 60,
            shuffleQuestions: document.getElementById('shuffle-questions').checked,
            shuffleAnswers: document.getElementById('shuffle-answers').checked,
            showFeedback: document.getElementById('show-feedback').checked
        };
        if (analyticsChart) { analyticsChart.destroy(); analyticsChart = null; }
        socket.emit('start_test_broadcast', { test: currentTestToStart.data, settings, path: currentTestToStart.path });
        showActiveSession(currentTestToStart.data);
    });
    btn('stop-test-btn', () => { 
        if (analyticsChart) { analyticsChart.destroy(); analyticsChart = null; }
        socket.emit('stop_test_broadcast'); 
        activeSection.classList.add('hidden'); 
        listSection.classList.remove('hidden'); 
    });
}

function renderBuilder() {
    if (!builder) return;
    builder.innerHTML = questions.map((q, i) => `
        <div class="card">
            <input type="text" value="${q.text}" onchange="questions[${i}].text=this.value" placeholder="Питання...">
            <div><button onclick="questions.splice(${i},1);renderBuilder()" style="background:var(--error);">Видалити</button></div>
        </div>
    `).join('');
}

function showActiveSession(data) {
    activeSection.classList.remove('hidden');
    listSection.classList.add('hidden');
    document.getElementById('active-test-name').innerText = data.title;
}

async function refreshResults() {
    const res = await fetch('/api/results');
    const files = await res.json();
    resultsList.innerHTML = files.map(f => `<div>${f.name} <button onclick="deleteResult('${f.path}')">X</button></div>`).join('');
}

window.deleteResult = async (path) => { await fetch(`/api/results/${path}`, { method: 'DELETE' }); refreshResults(); };
window.openAiGenerator = () => alert('В розробці');

function updateAnalyticsChart(students, testQuestions) {
    if (!testQuestions || testQuestions.length === 0) return;
    const ctx = document.getElementById('analyticsChart');
    if (!ctx) return;

    const labels = testQuestions.map((_, i) => `П ${i + 1}`);
    const correctCounts = testQuestions.map(() => 0);
    const incorrectCounts = testQuestions.map(() => 0);

    students.forEach(s => {
        testQuestions.forEach((q, i) => {
            const res = s.results[q.id];
            if (res) {
                if (res.isCorrect) correctCounts[i]++;
                else incorrectCounts[i]++;
            }
        });
    });

    if (analyticsChart) {
        analyticsChart.data.datasets[0].data = correctCounts;
        analyticsChart.data.datasets[1].data = incorrectCounts;
        analyticsChart.update();
    } else {
        analyticsChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    { label: 'Правильно', data: correctCounts, backgroundColor: '#10b981' },
                    { label: 'Неправильно', data: incorrectCounts, backgroundColor: '#ef4444' }
                ]
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false, 
                scales: { 
                    y: { beginAtZero: true, ticks: { stepSize: 1 } } 
                } 
            }
        });
    }
}

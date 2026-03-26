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
let activeTestPin = null;
let currentPath = '';
let editingTest = null;
let currentTestToStart = null;
let analyticsChart = null;
let currentViewedArchive = null;
let allArchiveFiles = [];

// DOM Elements
let testList, breadcrumbs, listSection, createSection, activeSection, archiveSection, resultsList, builder, groupsSection, groupsList;

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
    groupsSection = document.getElementById('groups-management-section');
    groupsList = document.getElementById('groups-list');

    // Socket Initialization
    socket = io();

    socket.on('connect', () => {
        document.getElementById('connection-status').innerText = '✅ Онлайн';
        socket.emit('teacher_join');
    });

    socket.on('connect_error', (err) => {
        document.getElementById('connection-status').innerText = '❌ Помилка з\'єднання';
    });

    socket.on('sessions_list_update', (sessions) => {
        const section = document.getElementById('sessions-list-section');
        const list = document.getElementById('active-sessions-list');
        if (!section || !list) return;
        
        if (sessions.length === 0) {
            section.classList.add('hidden');
        } else {
            section.classList.remove('hidden');
            list.innerHTML = sessions.map(s => `
                <div class="card" style="display: flex; justify-content: space-between; align-items: center; padding: 10px; border-left: 4px solid var(--success);">
                    <div>
                        <strong style="font-size: 1.1rem;">${s.title}</strong>
                        <div style="font-size: 0.85rem; color: #666; margin-top: 4px;">PIN-код / Назва: <span style="font-weight: bold; color: var(--accent); font-size: 1rem;">${s.pin}</span> | Студентів онлайн: ${s.studentCount}</div>
                    </div>
                    <div style="display: flex; gap: 5px;">
                        <button onclick="viewSession('${s.pin}')" style="background-color: var(--primary); padding: 5px 10px;">📊 Відкрити</button>
                        <button onclick="stopSession('${s.pin}')" style="background-color: var(--error); padding: 5px 10px;">🛑 Зупинити</button>
                    </div>
                </div>
            `).join('');
        }
    });

    socket.on('init_state', (data) => {
        refreshTests();
        updateServerInfo();
        if (data.activeTest) {
            activeTest = data.activeTest;
            activeTestPin = data.pin;
            showActiveSession(data.activeTest);
        }
        if (data.students) {
            updateProgressGrid(data.students);
            updateAnalyticsChart(data.students, activeTest ? activeTest.questions : []);
        }
    });

    socket.on('student_update', (data) => {
        if (activeTestPin === data.pin) {
            updateProgressGrid(data.students);
            updateAnalyticsChart(data.students, activeTest ? activeTest.questions : []);
        }
    });

    socket.on('session_update', (data) => {
        if (activeSession && data.pin === activeSession.pin) {
            activeSession = data;
            updateProgressGrid(activeSession.students, 'students-progress-grid');
            updateAnalyticsChart(activeSession.students, activeSession.test ? activeSession.test.questions : []);
        }
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

function renderMath(element) {
    if (window.renderMathInElement && element) {
        renderMathInElement(element, {
            delimiters: [
                {left: '$$', right: '$$', display: true},
                {left: '$', right: '$', display: false},
                {left: '\\(', right: '\\)', display: false},
                {left: '\\[', right: '\\]', display: true}
            ],
            throwOnError: false
        });
    }
}

function updateProgressGrid(students, containerId = 'students-progress-grid') {
    if (containerId === 'students-progress-grid') {
        document.getElementById('student-count').innerText = students.length;
    }
    const grid = document.getElementById(containerId);
    if (!grid) return;
    grid.innerHTML = students.map(s => {
        let statusColor = s.status === 'offline' ? 'var(--error)' : 'var(--success)';
        const questionsToUse = s.questions || (activeTest ? activeTest.questions : []) || [];
        const totalPossible = (questionsToUse && questionsToUse.length > 0) ? 
            questionsToUse.reduce((sum, q) => sum + (q.score || 1), 0) : 1;
        
        let grade12 = 0;
        if (totalPossible > 0) {
            grade12 = Math.round(((s.score || 0) / totalPossible) * 12);
        }

        let progressHtml = '';
        if (questionsToUse) {
            questionsToUse.forEach(q => {
                const res = s.results[q.id];
                let color = res ? (res.isCorrect ? 'var(--success)' : 'var(--error)') : 'var(--skipped)';
                progressHtml += `<div title="${q.text.substring(0, 50)}..." style="width:15px;height:15px;background:${color};border-radius:3px;cursor:help;"></div>`;
            });
        }

        return `<div class="card" style="display:flex;justify-content:space-between;border-left:5px solid ${statusColor};">
            <div><strong>${s.name}</strong><div style="display:flex;gap:3px;margin-top:5px;flex-wrap:wrap;">${progressHtml}</div></div>
            <div style="text-align:right;">
                <div style="font-size:1.2rem;font-weight:bold;color:var(--primary);">${grade12 || 0} б.</div>
                <div style="font-size:0.8rem;color:#666;">${s.score || 0} / ${totalPossible}</div>
            </div>
        </div>`;
    }).join('');
    renderMath(grid);
}

async function refreshTests() {
    try {
        const res = await fetch('/api/tests');
        const data = await res.json();
        tests = Array.isArray(data.tests) ? data.tests : [];
        
        if (data.lastModified || data.serverTime) {
            const date = new Date(data.lastModified || data.serverTime);
            const timeStr = date.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const dateStr = date.toLocaleDateString('uk-UA');
            
            const serverDate = new Date(data.serverTime);
            const serverTimeStr = serverDate.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

            const lastUpdatedEl = document.getElementById('last-updated');
            if (lastUpdatedEl) {
                lastUpdatedEl.innerHTML = `Остання зміна: ${dateStr} ${timeStr} <br><small style="opacity:0.7">Час сервера: ${serverTimeStr}</small>`;
            }
        }
        renderTestList();
    } catch (e) {
        console.error('Failed to refresh tests:', e);
    }
}

window.navigateTo = (path) => { currentPath = path; renderTestList(); };

function renderTestList() {
    if (!testList || !breadcrumbs) return;
    
    // Safety check: if currentPath is not empty and no items exist in it, check if the folder still exists at all
    const folderExists = currentPath === '' || tests.some(t => t.path === currentPath || t.path.startsWith(currentPath + '/'));
    if (!folderExists) {
        console.warn(`Path ${currentPath} no longer exists. Returning to root.`);
        currentPath = '';
    }

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
    renderMath(testList);
}

window.goHome = () => {
    navigateTo('');
    document.getElementById('test-settings-section').classList.add('hidden');
    createSection.classList.add('hidden');
    activeSection.classList.add('hidden');
    archiveSection.classList.add('hidden');
    document.getElementById('sessions-list-section').classList.remove('hidden');
    listSection.classList.remove('hidden');
    
    currentViewedArchive = null;
    document.getElementById('stop-test-btn').classList.remove('hidden');
    const closeBtn = document.getElementById('close-results-btn');
    if (closeBtn) closeBtn.classList.add('hidden');
};

window.viewSession = (pin) => {
    socket.emit('teacher_view_session', pin);
};

window.stopSession = (pin) => {
    console.log(`[UI] Attempting to stop session: ${pin}`);
    if (!socket || !socket.connected) {
        alert('❌ Помилка: немає зв\'язку з сервером. Неможливо зупинити тест зараз.');
        return;
    }
    if (confirm('Зупинити тест? Результати будуть збережені автоматично.')) {
        console.log(`[UI] Sending stop_test_broadcast for PIN: ${pin}`);
        socket.emit('stop_test_broadcast', pin);
        if (activeTestPin === pin) {
            if (analyticsChart) { analyticsChart.destroy(); analyticsChart = null; }
            activeSection.classList.add('hidden');
            listSection.classList.remove('hidden');
            activeTestPin = null;
            activeTest = null;
        } else {
            console.log(`[UI] Test stopped from sessions list. Waiting for server broadcast to refresh UI.`);
        }
    } else {
        console.log(`[UI] Stop cancelled by user.`);
    }
};

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
    
    // Test execution settings
    btn('start-with-settings-btn', () => {
        const settings = { 
            pin: (document.getElementById('test-pin').value || "").trim() || null,
            pickCount: parseInt(document.getElementById('test-pick-count').value) || null,
            timerType: document.getElementById('timer-type').value,
            timerValue: parseInt(document.getElementById('timer-value').value) || 60,
            shuffleQuestions: document.getElementById('shuffle-questions').checked,
            shuffleAnswers: document.getElementById('shuffle-answers').checked,
            showFeedback: document.getElementById('show-feedback').checked,
            showCorrect: document.getElementById('show-correct').checked,
            showScore: document.getElementById('show-score').checked
        };
        // Just emit and hide settings, the sessions_list_update will show the new session
        socket.emit('start_test_broadcast', { test: currentTestToStart.data, settings, path: currentTestToStart.path });
        
        document.getElementById('test-settings-section').classList.add('hidden');
        listSection.classList.remove('hidden');
    });
    btn('cancel-settings-btn', () => {
        document.getElementById('test-settings-section').classList.add('hidden');
        listSection.classList.remove('hidden');
    });
    btn('export-excel-btn', () => {
        if (activeTestPin) {
            window.location.href = `/api/export-results?pin=${activeTestPin}`;
        } else if (currentViewedArchive) {
            window.location.href = `/api/export-results?filename=${currentViewedArchive}`;
        }
    });
    btn('archive-export-btn', () => {
        if (currentViewedArchive) {
            window.location.href = `/api/export-results?filename=${currentViewedArchive}`;
        }
    });

    btn('stop-test-btn', () => { 
        if (activeTestPin) {
            window.stopSession(activeTestPin);
        } else {
            activeSection.classList.add('hidden'); 
            listSection.classList.remove('hidden');
        }
    });

    btn('refresh-tests-btn', () => {
        refreshTests();
    });

    // Archive
    btn('show-results-btn', () => {
        listSection.classList.add('hidden');
        archiveSection.classList.remove('hidden');
        refreshResults();
    });
    btn('back-to-tests-btn', () => {
        archiveSection.classList.add('hidden');
        listSection.classList.remove('hidden');
    });
    btn('close-results-btn', () => {
        if (window.closeArchivedResult) window.closeArchivedResult();
    });

    const searchInput = document.getElementById('archive-search');
    if (searchInput) {
        searchInput.oninput = () => renderResults();
    }
    
    // Folder Controls
    const folderGroup = document.getElementById('folder-input-group');
    const folderBtn = document.getElementById('show-folder-input-btn');
    
    if (folderBtn) {
        btn('show-folder-input-btn', () => {
            folderGroup.classList.remove('hidden');
            folderBtn.classList.add('hidden');
            document.getElementById('new-folder-name').focus();
        });
        btn('cancel-folder-btn', () => {
            folderGroup.classList.add('hidden');
            folderBtn.classList.remove('hidden');
            document.getElementById('new-folder-name').value = '';
        });
        btn('confirm-folder-btn', async () => {
            const name = document.getElementById('new-folder-name').value.trim();
            if (!name) return;
            const targetPath = currentPath ? `${currentPath}/${name}` : name;
            await fetch('/api/tests/folder', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ folder: targetPath })
            });
            folderGroup.classList.add('hidden');
            folderBtn.classList.remove('hidden');
            document.getElementById('new-folder-name').value = '';
            refreshTests();
        });
    }

    // Group Management Listeners
    btn('show-groups-btn', () => {
        listSection.classList.add('hidden');
        groupsSection.classList.remove('hidden');
        refreshGroups();
    });
    btn('back-from-groups-btn', () => {
        groupsSection.classList.add('hidden');
        listSection.classList.remove('hidden');
    });
    btn('save-group-btn', async () => {
        await saveGroup();
    });
}

function renderBuilder() {
    if (!builder) return;
    builder.innerHTML = questions.map((q, i) => {
        let optionsHtml = '';
        if (q.type === 'single' || q.type === 'multiple') {
            optionsHtml = `
                <div style="margin-top: 10px;">
                    <strong>Варіанти (позначте правильні):</strong>
                    <div id="options-${i}">
                        ${(q.options || []).map((opt, optIdx) => {
                            const isChecked = Array.isArray(q.answer) ? q.answer.includes(opt) : q.answer === opt;
                            return `
                            <div style="display:flex; gap:5px; margin-bottom:5px;">
                                <input type="${q.type === 'single' ? 'radio' : 'checkbox'}" name="correct-${i}" ${isChecked ? 'checked' : ''} onchange="updateCorrectAnswer(${i}, ${optIdx})">
                                <input type="text" value="${opt}" onchange="questions[${i}].options[${optIdx}]=this.value; renderBuilder()" style="flex:1;">
                                <button onclick="questions[${i}].options.splice(${optIdx},1); renderBuilder()" style="background:var(--error); padding: 5px;">X</button>
                            </div>`;
                        }).join('')}
                    </div>
                    <button onclick="questions[${i}].options.push(''); renderBuilder()" class="secondary" style="font-size:0.8rem; padding: 5px 10px;">+ Додати варіант</button>
                </div>
            `;
        } else if (q.type === 'matching') {
            optionsHtml = `
                <div style="margin-top: 10px;">
                    <strong>Пари для відповідності:</strong>
                    <div id="pairs-${i}">
                        ${(q.pairs || []).map((p, pIdx) => `
                            <div style="display:flex; gap:5px; margin-bottom:5px;">
                                <input type="text" value="${p.left}" placeholder="Ліва частина" onchange="questions[${i}].pairs[${pIdx}].left=this.value; syncMatchingAnswer(${i})" style="flex:1;">
                                <span>➔</span>
                                <input type="text" value="${p.right}" placeholder="Права частина" onchange="questions[${i}].pairs[${pIdx}].right=this.value; syncMatchingAnswer(${i})" style="flex:1;">
                                <button onclick="questions[${i}].pairs.splice(${pIdx},1); syncMatchingAnswer(${i}); renderBuilder()" style="background:var(--error); padding: 5px;">X</button>
                            </div>
                        `).join('')}
                    </div>
                    <button onclick="if(!questions[${i}].pairs)questions[${i}].pairs=[]; questions[${i}].pairs.push({left:'',right:''}); syncMatchingAnswer(${i}); renderBuilder()" class="secondary" style="font-size:0.8rem; padding: 5px 10px;">+ Додати пару</button>
                </div>
            `;
        } else if (q.type === 'text') {
            optionsHtml = `
                <div style="margin-top: 10px;">
                    <strong>Правильна відповідь:</strong>
                    <input type="text" value="${q.answer}" onchange="questions[${i}].answer=this.value" style="width:100%;">
                </div>
            `;
        } else if (q.type === 'true_false') {
            optionsHtml = `
                <div style="margin-top: 10px;">
                    <strong>Правильна відповідь:</strong>
                    <select onchange="questions[${i}].answer=this.value" style="width:100%;">
                        <option value="правда" ${q.answer === 'правда' ? 'selected' : ''}>Правда (Так)</option>
                        <option value="неправда" ${q.answer === 'неправда' ? 'selected' : ''}>Неправда (Ні)</option>
                    </select>
                </div>
            `;
        }

        return `
        <div class="card" style="border-left: 5px solid var(--primary); position: relative;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
                <div style="flex: 1; margin-right: 10px;">
                    <label style="font-size: 0.8rem; font-weight: bold; color: #666;">Тип питання:</label>
                    <select onchange="changeQuestionType(${i}, this.value)" style="width: 100%; margin-bottom: 5px;">
                        <option value="single" ${q.type === 'single' ? 'selected' : ''}>Одинарний вибір</option>
                        <option value="multiple" ${q.type === 'multiple' ? 'selected' : ''}>Множинний вибір</option>
                        <option value="true_false" ${q.type === 'true_false' ? 'selected' : ''}>Правда/Неправда</option>
                        <option value="text" ${q.type === 'text' ? 'selected' : ''}>Введення тексту</option>
                        <option value="matching" ${q.type === 'matching' ? 'selected' : ''}>Відповідність</option>
                    </select>
                </div>
                <div style="width: 80px;">
                    <label style="font-size: 0.8rem; font-weight: bold; color: #666;">Бали:</label>
                    <input type="number" step="0.5" value="${q.score || 1}" onchange="questions[${i}].score=parseFloat(this.value)" style="width: 100%; margin-bottom: 5px;">
                </div>
                <div style="width: 80px;">
                    <label style="font-size: 0.8rem; font-weight: bold; color: #666;">Час (сек):</label>
                    <input type="number" value="${q.time || 0}" placeholder="0=авто" onchange="questions[${i}].time=parseInt(this.value)" style="width: 100%; margin-bottom: 5px;">
                </div>
                <button onclick="questions.splice(${i},1);renderBuilder()" style="background:var(--error); margin-left: 10px;">✕</button>
            </div>
            
            <textarea placeholder="Текст питання..." onchange="questions[${i}].text=this.value" style="width: 100%; min-height: 60px; font-size: 1.1rem; border: 1px solid #ddd; border-radius: 4px; padding: 8px;">${q.text}</textarea>
            
            <div style="margin-top: 10px;">
                <label style="font-size: 0.8rem; font-weight: bold; color: #666;">Зображення (URL):</label>
                <input type="text" value="${q.image || ''}" placeholder="/media/image.png" onchange="questions[${i}].image=this.value" style="width: 100%;">
            </div>

            ${optionsHtml}
        </div>
        `;
    }).join('');
    renderMath(builder);
}

window.changeQuestionType = (idx, type) => {
    const q = questions[idx];
    q.type = type;
    if (type === 'single' || type === 'multiple') {
        if (!q.options) q.options = ['Варіант 1', 'Варіант 2'];
        q.answer = type === 'single' ? q.options[0] : [q.options[0]];
    } else if (type === 'true_false') {
        q.answer = 'правда';
        delete q.options;
    } else if (type === 'matching') {
        q.pairs = [{left: 'А', right: '1'}];
        q.answer = {'А': '1'};
        delete q.options;
    } else if (type === 'text') {
        q.answer = '';
        delete q.options;
    }
    renderBuilder();
};

window.updateCorrectAnswer = (qIdx, optIdx) => {
    const q = questions[qIdx];
    const opt = q.options[optIdx];
    if (q.type === 'single') {
        q.answer = opt;
    } else {
        if (!Array.isArray(q.answer)) q.answer = [];
        const index = q.answer.indexOf(opt);
        if (index > -1) q.answer.splice(index, 1);
        else q.answer.push(opt);
    }
};

window.syncMatchingAnswer = (idx) => {
    const q = questions[idx];
    if (!q.pairs) return;
    q.answer = {};
    q.pairs.forEach(p => {
        if (p.left) q.answer[p.left] = p.right;
    });
};

function showActiveSession(data) {
    activeSection.classList.remove('hidden');
    listSection.classList.add('hidden');
    document.getElementById('active-test-name').innerText = data.title;
}

async function refreshResults() {
    try {
        const res = await fetch('/api/results');
        allArchiveFiles = await res.json();
        renderResults();
    } catch (e) {
        console.error('Failed to refresh results:', e);
    }
}

function renderResults() {
    const list = document.getElementById('results-list');
    const search = document.getElementById('archive-search').value.toLowerCase();
    
    const filtered = allArchiveFiles.filter(f => f.name.toLowerCase().includes(search));
    
    list.innerHTML = filtered.map(f => {
        // Try to parse info from filename (Title_PIN_Date.json)
        const parts = f.name.replace('.json', '').split('_');
        let displayTitle = f.name;
        let dateInfo = '';
        let pinInfo = '';
        
        if (parts.length >= 3) {
            const dateStr = parts.pop();
            const pinStr = parts.pop();
            displayTitle = parts.join(' ').replace(/_/g, ' ');
            dateInfo = `<span style="color: #666; font-size: 0.85rem;">📅 ${dateStr.replace(/-/g, '.')}</span>`;
            pinInfo = `<span style="background: #eef2ff; color: var(--primary); padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 0.85rem;">PIN: ${pinStr}</span>`;
        }

        return `
            <div class="card" style="display:flex; justify-content:space-between; align-items:center; padding:15px; margin-bottom: 10px; border-left: 4px solid var(--primary);">
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: bold; margin-bottom: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">📄 ${displayTitle}</div>
                    <div style="display: flex; gap: 10px; align-items: center;">
                        ${pinInfo}
                        ${dateInfo}
                    </div>
                </div>
                <div style="display:flex; gap:5px; flex-shrink: 0; margin-left: 10px;">
                    <button onclick="restoreSession('${f.name}')" style="background:var(--success); padding: 8px 10px;" title="Відновити сесію (зробити активною)">🔄</button>
                    <button onclick="viewArchivedResult('${f.name}')" style="background:var(--primary); padding: 8px 15px;">👁️ Відкрити</button>
                    <button onclick="deleteResult('${f.name}')" style="background:var(--error); padding: 8px 15px;">X</button>
                </div>
            </div>
        `;
    }).join('');
    renderMath(list);
    
    if (filtered.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: #666; padding: 20px;">Результатів не знайдено 🔍</p>';
    }
}

window.viewArchivedResult = async (filename) => {
    try {
        const res = await fetch(`/api/results-data/${filename}`);
        if (!res.ok) throw new Error('Cannot load JSON');
        const sessionData = await res.json();
        
        currentViewedArchive = filename;
        document.getElementById('archive-test-name').innerText = (sessionData.test && sessionData.test.title) || filename;
        
        // Use the modal-specific grid I added earlier
        updateProgressGrid(sessionData.students, 'archive-progress-grid');
        
        document.getElementById('archive-modal').style.display = 'block';
    } catch(e) {
        alert('Помилка завантаження файлу: ' + e.message);
    }
};

window.restoreSession = async (filename) => {
    if (!confirm('Ви дійсно хочете відновити цю сесію? Це зробить ПІН-код знову активним для входу студентів.')) return;
    socket.emit('teacher_restore_session', filename);
    alert('Запит на відновлення надіслано. Перевірте список активних тестів.');
    goHome();
};

window.closeArchivedResult = () => {
    activeSection.classList.add('hidden');
    document.getElementById('results-archive-section').classList.remove('hidden');
    document.getElementById('stop-test-btn').classList.remove('hidden');
    
    const closeBtn = document.getElementById('close-results-btn');
    if (closeBtn) closeBtn.classList.add('hidden');
    
    activeTest = null;
    activeTestPin = null;
    currentViewedArchive = null;
};

window.deleteResult = async (path) => {
    if (confirm('Видалити цей результат?')) {
        await fetch(`/api/results/${path}`, { method: 'DELETE' }); 
        refreshResults(); 
    }
};
window.openAiGenerator = () => {
    const topic = prompt('Введіть тему для генерації тесту (напр: "Будова атома", "Закони Ньютона"):');
    if (!topic) return;
    
    const count = prompt('Кількість питань:', '10');
    if (!count) return;

    alert('Генерація розпочата. Якщо ви працюєте в режимі ШІ-асистента, я отримаю ваш запит і згенерую питання прямо в файл тесту. Будь ласка, зачекайте...');
    
    fetch('/api/ai-generate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ topic, count: parseInt(count), currentPath: currentPath })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            alert('Запит на генерацію надіслано. Оновіть список тестів через кілька секунд.');
            refreshTests();
        } else {
            alert('Помилка: ' + (data.error || 'Невідома помилка'));
        }
    })
    .catch(err => alert('Помилка мережі: ' + err.message));
};

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

// --- Group Management Functions ---
async function refreshGroups() {
    try {
        const res = await fetch('/api/groups');
        const groups = await res.json();
        renderGroups(groups);
    } catch (e) {
        console.error('Failed to refresh groups:', e);
    }
}

function renderGroups(groups) {
    if (!groupsList) return;
    if (groups.length === 0) {
        groupsList.innerHTML = '<p style="color: #666; font-style: italic;">Груп ще не створено.</p>';
        return;
    }
    groupsList.innerHTML = groups.map(g => `
        <div class="card" style="display: flex; justify-content: space-between; align-items: center; padding: 10px; border-left: 4px solid var(--accent);">
            <div>
                <strong>${g.name}</strong>
                <div style="font-size: 0.8rem; color: #666;">Студентів: ${g.students.length}</div>
            </div>
            <div style="display: flex; gap: 5px;">
                <button onclick="editGroup('${g.name}', ${JSON.stringify(g.students).replace(/"/g, '&quot;')})" style="background-color: var(--primary); padding: 5px 10px;">✏️</button>
                <button onclick="deleteGroup('${g.name}')" style="background-color: var(--error); padding: 5px 10px;">🗑️</button>
            </div>
        </div>
    `).join('');
}

window.editGroup = (name, students) => {
    document.getElementById('group-name-input').value = name;
    document.getElementById('group-students-input').value = students.join('\n');
};

async function saveGroup() {
    const name = document.getElementById('group-name-input').value.trim();
    const studentsRaw = document.getElementById('group-students-input').value.trim();
    if (!name || !studentsRaw) {
        alert('Будь ласка, вкажіть назву та список студентів.');
        return;
    }
    const students = studentsRaw.split('\n').map(s => s.trim()).filter(s => s !== '');
    
    try {
        const res = await fetch('/api/groups', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ name, students })
        });
        if (res.ok) {
            document.getElementById('group-name-input').value = '';
            document.getElementById('group-students-input').value = '';
            refreshGroups();
        } else {
            alert('Помилка збереження групи.');
        }
    } catch (e) {
        console.error('Save group error:', e);
    }
}

window.deleteGroup = async (name) => {
    if (!confirm(`Видалити групу ${name}?`)) return;
    try {
        const res = await fetch(`/api/groups/${name}`, { method: 'DELETE' });
        if (res.ok) refreshGroups();
    } catch (e) {
        console.error('Delete group error:', e);
    }
};

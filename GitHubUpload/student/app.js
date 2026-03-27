const socket = io();
const joinSection = document.getElementById('join-section');
const waitingSection = document.getElementById('waiting-section');
const testSection = document.getElementById('test-section');
const finishedSection = document.getElementById('finished-section');
const cheatWarningBanner = document.getElementById('cheat-warning-banner');
const qContainer = document.getElementById('question-container');
const breakSection = document.getElementById('break-section');
const welcomeBanner = document.getElementById('welcome-banner');

let currentTest = null;
let currentQIndex = 0;
let initialHeight = window.innerHeight;
let timerInterval = null;
let timeLeft = 0;
let perQuestionTimer = false;
let isBreakActive = false;
let localAnswers = {};
let studentGroups = [];

function getStudentToken() {
    let token = localStorage.getItem('studentToken');
    if (!token) {
        token = 'std_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
        localStorage.setItem('studentToken', token);
    }
    return token;
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

function formatImageUrl(url) {
    if (!url) return '';
    // Handle Google Drive view links
    const gdMatch = String(url).match(/drive\.google\.com\/file\/d\/([^\/\?]+)/);
    if (gdMatch && gdMatch[1]) {
        return `https://drive.google.com/uc?export=view&id=${gdMatch[1]}`;
    }
    return url;
}

function checkBrowserSupport() {
    const ua = navigator.userAgent;
    const vendor = navigator.vendor;
    
    const isFirefox = ua.indexOf('Firefox') > -1;
    const isEdge = ua.indexOf('Edg/') > -1;
    const isOpera = ua.indexOf('OPR/') > -1 || ua.indexOf('Opera/') > -1;
    const isIE = ua.indexOf('MSIE') > -1 || ua.indexOf('Trident/') > -1;
    
    // Built-in mobile browsers (allow those)
    const isSamsung = ua.indexOf('SamsungBrowser') > -1;
    const isMiui = ua.indexOf('MiuiBrowser') > -1;

    // Chrome detection (careful with Edge/Opera/Brave which also have 'Chrome')
    const isChrome = ua.indexOf('Chrome') > -1 && !isEdge && !isOpera;
    
    // Safari detection (careful with Chrome/Edge which also have 'Safari')
    const isSafari = ua.indexOf('Safari') > -1 && !isChrome && !isFirefox && !isEdge && !isOpera;
    
    // Block common mobile browsers specifically if they identify differently but user wants to be strict
    const isMobileForbidden = ua.indexOf('UCBrowser') > -1 || 
                             ua.indexOf('DuckDuckGo') > -1 ||
                             ua.indexOf('Brave') > -1 ||
                             ua.indexOf('Puffin') > -1 ||
                             ua.indexOf('Mint') > -1;

    if (isMobileForbidden) return false;
    return isChrome || isFirefox || isSafari || isEdge || isOpera || isIE || isSamsung || isMiui;
}

document.getElementById('join-btn').onclick = (e) => {
    const groupSelect = document.getElementById('student-group');
    const nameSelect = document.getElementById('student-name-select');
    const nameInput = document.getElementById('student-name-input');
    const noNameCheckbox = document.getElementById('no-name-in-list');
    const pin = document.getElementById('student-pin').value.trim();

    let name = '';
    let group = '';

    if (noNameCheckbox.checked) {
        name = nameInput.value.trim();
        group = 'Інша';
    } else {
        name = nameSelect.value;
        group = groupSelect.value;
    }

    if (!name) return alert('Будь ласка, вкажіть прізвище та ім\'я');
    if (!pin) return alert('Будь ласка, введіть PIN-код або Групу!');
    
    // Enter fullscreen
    try {
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen();
        } else if (document.documentElement.webkitRequestFullscreen) {
            document.documentElement.webkitRequestFullscreen();
        }
    } catch (e) {}
    
    // Disable button to prevent double clicks
    e.target.disabled = true;
    const oldText = e.target.innerText;
    e.target.innerText = 'Приєднуємо...';
    
    // Save to local storage for persistence
    localStorage.setItem('studentName', name);
    localStorage.setItem('studentGroup', group);
    localStorage.setItem('studentPin', pin);
    
    socket.emit('student_join', { name, group, pin, token: getStudentToken() });
};

// Auto-populate and Group fetch
window.addEventListener('load', async () => {
    // Browser support check
    if (!checkBrowserSupport()) {
        const joinSec = document.getElementById('join-section');
        const errSec = document.getElementById('browser-error-section');
        if (joinSec) joinSec.classList.add('hidden');
        if (errSec) errSec.classList.remove('hidden');
        return; // Stop further initialization
    }

    const groupSelect = document.getElementById('student-group');
    const nameSelect = document.getElementById('student-name-select');
    const nameInput = document.getElementById('student-name-input');
    const noNameCheckbox = document.getElementById('no-name-in-list');
    const nameContainer = document.getElementById('name-selection-container');
    const manualContainer = document.getElementById('manual-name-container');

    // Toggle manual entry
    noNameCheckbox.onchange = () => {
        if (noNameCheckbox.checked) {
            nameContainer.classList.add('hidden');
            manualContainer.classList.remove('hidden');
        } else {
            nameContainer.classList.remove('hidden');
            manualContainer.classList.add('hidden');
        }
    };

    // Load groups
    try {
        const res = await fetch('/api/groups');
        studentGroups = await res.json();
        
        // Populate groups
        groupSelect.innerHTML = '<option value="">-- Виберіть групу --</option>' + 
            studentGroups.map(g => `<option value="${g.name}">${g.name}</option>`).join('') +
            '<option value="Інша">Інша / Немає в списку</option>';

        groupSelect.onchange = () => {
            const selectedGroup = studentGroups.find(g => g.name === groupSelect.value);
            if (selectedGroup) {
                nameSelect.innerHTML = '<option value="">-- Виберіть Прізвище Ім\'я --</option>' + 
                    selectedGroup.students.map(s => `<option value="${s}">${s}</option>`).join('');
                noNameCheckbox.checked = false;
                noNameCheckbox.onchange();
            } else if (groupSelect.value === 'Інша') {
                noNameCheckbox.checked = true;
                noNameCheckbox.onchange();
            } else {
                nameSelect.innerHTML = '';
            }
        };

        // Attempt restore from localStorage
        const savedGroup = localStorage.getItem('studentGroup');
        const savedName = localStorage.getItem('studentName');
        const savedPin = localStorage.getItem('studentPin');

        if (savedGroup) {
            groupSelect.value = savedGroup;
            groupSelect.onchange();
            if (savedName && !savedGroup.includes('Інша')) {
                nameSelect.value = savedName;
            } else if (savedName) {
                nameInput.value = savedName;
            }
        }
        if (savedPin) {
            document.getElementById('student-pin').value = savedPin;
        }
    } catch (e) {
        console.error('Failed to load groups:', e);
        // Fallback to manual if API fails
        noNameCheckbox.checked = true;
        noNameCheckbox.onchange();
    }
});

socket.on('join_error', (msg) => { 
    alert(msg); 
    const btn = document.getElementById('join-btn');
    btn.disabled = false;
    btn.innerText = 'Приєднатися (На весь екран)';
});

socket.on('start_test', (test) => {
    const savedPin = localStorage.getItem('studentPin');
    const progressKey = `progress_${test.title}_${savedPin}`;
    const savedProgress = localStorage.getItem(progressKey);
    
    currentTest = test;
    currentQIndex = 0;
    localAnswers = {};

    if (savedProgress) {
        try {
            const data = JSON.parse(savedProgress);
            if (confirm('Виявлено незавершений тест. Продовжити з місця зупинки?')) {
                currentQIndex = data.qIndex || 0;
                localAnswers = data.answers || {};
                // Re-sync answers to server
                Object.keys(localAnswers).forEach(qId => {
                    socket.emit('submit_answer', { questionId: qId, answer: localAnswers[qId] });
                });
            } else {
                localStorage.removeItem(progressKey);
            }
        } catch (e) {
            console.error('Error loading progress:', e);
        }
    }

    joinSection.classList.add('hidden');
    waitingSection.classList.add('hidden');
    testSection.classList.remove('hidden');
    breakSection.classList.add('hidden');
    
    // Update header banner
    const greetingTitle = document.getElementById('greeting-title');
    const greetingText = document.getElementById('greeting-text');
    if (greetingTitle) greetingTitle.innerText = `📝 ${currentTest.title || 'Тестування'}`;
    if (greetingText) greetingText.innerText = `PIN-код: ${savedPin || '---'}`;
    if (welcomeBanner) welcomeBanner.style.padding = '10px 20px';
    
    // Global test timer check
    if (currentTest.settings && currentTest.settings.timerType === 'total') {
        perQuestionTimer = false;
        startTimer(currentTest.settings.timerValue);
    }
    
    renderQuestion();
});

socket.on('connect', () => {
    const name = localStorage.getItem('studentName');
    const pin = localStorage.getItem('studentPin');
    if (name && pin && testSection && !testSection.classList.contains('hidden')) {
        console.log('[DEBUG] Reconnected! Re-joining session...');
        socket.emit('student_join', { name, pin, token: getStudentToken() });
    }
});

socket.on('stop_test', () => {
    cleanupProgress();
    clearInterval(timerInterval);
    testSection.classList.add('hidden');
    finishedSection.classList.remove('hidden');
    cheatWarningBanner.classList.add('hidden');
    document.getElementById('feedback-overlay').classList.add('hidden');
});

function cleanupProgress() {
    if (currentTest) {
        const savedPin = localStorage.getItem('studentPin');
        localStorage.removeItem(`progress_${currentTest.title}_${savedPin}`);
    }
}

socket.on('test_locked', (reason) => {
    clearInterval(timerInterval);
    testSection.classList.add('hidden');
    joinSection.classList.add('hidden');
    waitingSection.classList.add('hidden');
    finishedSection.innerHTML = `<h2>🚫 ${reason}</h2><p>Ваш поточний результат анульовано. Зверніться до викладача.</p>`;
    finishedSection.classList.remove('hidden');
    cheatWarningBanner.classList.add('hidden');
    
    const tryBtn = document.createElement('button');
    tryBtn.innerText = 'Спробувати знову';
    tryBtn.style.marginTop = '20px';
    tryBtn.onclick = () => window.location.reload();
    finishedSection.appendChild(tryBtn);
    
    document.getElementById('feedback-overlay').classList.add('hidden');
});

const retakeBtn = document.getElementById('retake-btn');
if (retakeBtn) {
    retakeBtn.onclick = () => {
        let baseName = localStorage.getItem('studentName') || '';
        baseName = baseName.replace(/ \(Спроба \d+\)$/, '');
        
        let attempt = parseInt(localStorage.getItem('studentAttempt') || '1');
        attempt++;
        localStorage.setItem('studentAttempt', attempt.toString());
        
        const newName = `${baseName} (Спроба ${attempt})`;
        document.getElementById('student-name').value = newName;
        
        // Reset UI
        finishedSection.classList.add('hidden');
        joinSection.classList.remove('hidden');
        
        const joinBtn = document.getElementById('join-btn');
        joinBtn.disabled = false;
        joinBtn.innerText = 'Приєднатися (На весь екран)';
    };
}
function triggerCheatWarning() {
    if (!currentTest || !currentTest.questions[currentQIndex]) return;
    
    // Add small delay to let activeElement update (especially for mobile focus shifts)
    setTimeout(() => {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
            return; 
        }

        const questionId = currentTest.questions[currentQIndex].id;
        socket.emit('cheat_warning', { questionId });
        cheatWarningBanner.classList.remove('hidden');
    }, 200);
}

document.addEventListener('visibilitychange', () => { 
    if (document.visibilityState === 'hidden') triggerCheatWarning(); 
});

window.addEventListener('blur', () => {
    // Some mobile browsers trigger blur on split-screen entry
    triggerCheatWarning(); 
});

window.addEventListener('resize', () => { 
    checkViewportIntegrity();
});

function checkViewportIntegrity() {
    if (!currentTest) return;

    const activeEl = document.activeElement;
    const isInputFocused = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');
    
    // If input is focused, we assume the keyboard is open and skip resize/aspect-ratio checks
    if (isInputFocused) return;

    const width = window.innerWidth;
    const height = window.innerHeight;
    const screenW = window.screen.width;
    const screenH = window.screen.height;

    // 1. Check for suspicious split-screen proportions
    // If the browser window is significantly narrower/shorter than the device screen
    const widthRatio = width / screenW;
    const heightRatio = height / screenH;

    // Thresholds: if browser occupies less than 85% of screen width or height (outside of keyboard)
    // We only check width for portrait and height for landscape
    const isPortrait = height > width;
    
    let isSplitDetected = false;
    if (isPortrait && widthRatio < 0.85) isSplitDetected = true;
    if (!isPortrait && heightRatio < 0.85) isSplitDetected = true;

    // 2. Minimum absolute dimensions (e.g. split-screen 50/50 on a phone)
    if (width < 350 || height < 350) isSplitDetected = true;

    if (isSplitDetected) {
        triggerCheatWarning();
    }
}

// Heartbeat check (every 3 seconds)
setInterval(() => {
    if (currentTest && !testSection.classList.contains('hidden')) {
        if (!document.hasFocus()) {
            triggerCheatWarning();
        }
        checkViewportIntegrity();
    }
}, 3000);

function startTimer(seconds) {
    clearInterval(timerInterval);
    timeLeft = seconds;
    updateTimerDisplay();
    timerInterval = setInterval(() => {
        timeLeft--;
        updateTimerDisplay();
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            handleTimeUp();
        }
    }, 1000);
}

function updateTimerDisplay() {
    const min = Math.floor(timeLeft / 60);
    const sec = timeLeft % 60;
    document.getElementById('timer-display').innerText = 
        `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

function handleTimeUp() {
    if (perQuestionTimer) {
        submitAnswer('ЧАС ВИЙШОВ');
    } else if (currentTest.settings.timerType === 'total') {
        socket.emit('submit_answer', { questionId: currentTest.questions[currentQIndex].id, answer: 'ЧАС ВИЙШОВ' });
        testSection.classList.add('hidden');
        finishedSection.classList.remove('hidden');
    }
}

function renderQuestion() {
    try {
        if (!currentTest || !currentTest.questions) {
            testSection.innerHTML = '<div class="card"><h2>Очікування завантаження питань...</h2></div>';
            return;
        }

        const q = currentTest.questions[currentQIndex];
        
        // Restore warning banner if this question was already compromised
        if (q.isViolated) {
            cheatWarningBanner.classList.remove('hidden');
        } else {
            cheatWarningBanner.classList.add('hidden');
        }
        if (!q) {
            clearInterval(timerInterval);
            socket.emit('finish_test');
            
            // Switch to finished section immediately
            testSection.classList.add('hidden');
            finishedSection.classList.remove('hidden');
            
            // Show a pending message until results are received
            const statusMsg = document.createElement('p');
            statusMsg.id = 'result-pending-msg';
            statusMsg.innerText = 'Всі питання пройдено! Очікуйте нарахування балів...';
            statusMsg.style.color = 'var(--primary)';
            statusMsg.style.fontWeight = 'bold';
            finishedSection.querySelector('h2').after(statusMsg);
            return;
        }

        document.getElementById('progress-text').innerText = `Питання ${currentQIndex + 1} з ${currentTest.questions.length}`;

        // Priority: Individual Question Timer -> Global Per-Question Timer -> None
        let qTime = q.time || 0;
        if (qTime > 0) {
            perQuestionTimer = true;
            startTimer(qTime);
        } else if (currentTest.settings && currentTest.settings.timerType === 'per-question') {
            perQuestionTimer = true;
            startTimer(currentTest.settings.timerValue);
        }

        let inputHtml = '';
        if (q.type === 'single' || q.type === 'true_false') {
            const options = q.type === 'true_false' ? ['Так', 'Ні'] : q.options;
            inputHtml = options.map((opt, i) => `
                <label class="option-label" onclick="selectOption(this)">
                    <input type="radio" name="q-ans" value="${opt}" onchange="updateSelectedClass()">
                    <span>${opt}</span>
                </label>
            `).join('') + `<button onclick="submitSingle()" style="width: 100%; margin-top: 10px;">Підтвердити</button>`;
        } else if (q.type === 'multiple') {
            inputHtml = q.options.map((opt, i) => `
                <label class="option-label">
                    <input type="checkbox" name="q-ans" value="${opt}" onchange="updateSelectedClass()">
                    <span>${opt}</span>
                </label>
            `).join('') + `<button onclick="submitMultiple()" style="width: 100%; margin-top: 10px;">Підтвердити</button>`;
        } else if (q.type === 'text') {
            inputHtml = `
                <textarea id="text-ans" placeholder="Ваша відповідь..." style="width: 100%; height: 80px; margin-bottom: 10px; padding: 10px; border-radius: 8px; border: 1px solid #ddd;"></textarea>
                <button onclick="submitText()" style="width: 100%;">Підтвердити</button>
            `;
        } else if (q.type === 'matching') {
            const lefts = q.pairs.map(p => p.left);
            const rights = [...q.pairs.map(p => p.right)].sort(() => Math.random() - 0.5);
            
            inputHtml = `<div class="matching-container" style="display: flex; flex-direction: column; gap: 10px;">
                ${lefts.map((l, i) => `
                    <div style="display: flex; gap: 10px; align-items: stretch; position: relative;">
                        <div style="flex: 1; padding: 12px; border: 1px solid var(--primary); background: #e0e7ff; border-radius: 8px; display: flex; align-items: center; font-size: 0.95rem;">${l}</div>
                        <div class="custom-select-container" id="match-container-${i}">
                            <div class="custom-select-trigger" onclick="toggleMatchingSelect(${i})" id="match-trigger-${i}" data-value="" data-left="${l.replace(/"/g, '&quot;')}">-- Оберіть --</div>
                            <div class="custom-select-options">
                                ${rights.map(r => `<div class="custom-select-option" onclick="selectMatchingOption(${i}, '${r.replace(/'/g, "\\'")}')">${r}</div>`).join('')}
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
            <button onclick="submitMatching()" style="width: 100%; margin-top: 15px;">Підтвердити</button>`;
        }

        qContainer.innerHTML = `
            <div class="card question-card">
                ${q.image ? `<img src="${formatImageUrl(q.image)}" style="max-width: 100%; max-height: 300px; display: block; margin: 0 auto 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">` : ''}
                <div style="font-size: 1.3rem; margin-bottom: 2rem; line-height: 1.6; user-select: none;" onclick="event.stopPropagation()">${q.text}</div>
                <div id="inputs-container">${inputHtml}</div>
                <div style="margin-top: 20px; border-top: 1px solid #eee; padding-top: 15px;">
                    <button class="secondary" onclick="submitAnswer('ПРОПУЩЕНО')" style="width: 100%; background-color: #f3f4f6; color: #4b5563;">Пропустити питання</button>
                </div>
            </div>
        `;
        renderMath(qContainer);
    } catch (err) {
        console.error('Render Error:', err);
        testSection.innerHTML = `
            <div class="card" style="border: 2px solid var(--error);">
                <h2 style="color: var(--error);">Помилка відображення</h2>
                <p>Вибачте, сталася помилка при завантаженні питання. Спробуйте оновити сторінку.</p>
                <button onclick="location.reload()">Оновити сторінку</button>
            </div>
        `;
    }
}

window.updateSelectedClass = () => {
    document.querySelectorAll('.option-label').forEach(label => {
        const input = label.querySelector('input');
        label.classList.toggle('selected', input.checked);
    });
};

window.selectOption = (label) => {
    const input = label.querySelector('input');
    input.checked = true;
    updateSelectedClass();
};

window.submitSingle = () => {
    const selected = document.querySelector('input[name="q-ans"]:checked');
    if (!selected) return alert('Виберіть варіант');
    submitAnswer(selected.value);
};

window.submitMultiple = () => {
    const selected = Array.from(document.querySelectorAll('input[name="q-ans"]:checked')).map(i => i.value);
    if (selected.length === 0) return alert('Виберіть хоча б один варіант');
    submitAnswer(selected);
};

window.submitText = () => {
    const val = document.getElementById('text-ans').value;
    if (!val) return alert('Введіть відповідь');
    submitAnswer(val);
};

window.submitMatching = () => {
    const q = currentTest.questions[currentQIndex];
    if (!q.pairs) return;
    const ans = {};
    for (let i = 0; i < q.pairs.length; i++) {
        const trigger = document.getElementById(`match-trigger-${i}`);
        const val = trigger.dataset.value;
        if (!val) return alert('Знайдіть пару для всіх елементів');
        ans[trigger.dataset.left] = val;
    }
    submitAnswer(ans);
};

window.toggleMatchingSelect = (index) => {
    const container = document.getElementById(`match-container-${index}`);
    const isOpen = container.classList.contains('open');
    document.querySelectorAll('.custom-select-container').forEach(c => c.classList.remove('open'));
    if (!isOpen) container.classList.add('open');
};

window.selectMatchingOption = (index, value) => {
    const trigger = document.getElementById(`match-trigger-${index}`);
    trigger.innerText = value;
    trigger.dataset.value = value;
    document.getElementById(`match-container-${index}`).classList.remove('open');
    renderMath(trigger);
};

document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-select-container')) {
        document.querySelectorAll('.custom-select-container').forEach(c => c.classList.remove('open'));
    }
});

window.submitAnswer = (ans) => {
    if (perQuestionTimer) clearInterval(timerInterval);
    
    const q = currentTest.questions[currentQIndex];
    localAnswers[q.id] = ans;
    saveLocalProgress();
    
    socket.emit('submit_answer', { questionId: q.id, answer: ans });

    if (currentTest.settings && currentTest.settings.showFeedback) {
        // We'll wait for 'answer_feedback' event
    } else {
        nextQuestion();
    }
};

socket.on('answer_feedback', (data) => {
    if (currentTest.settings && currentTest.settings.showFeedback) {
        showFeedback(data.isCorrect, data.correctAnswer);
    }
});

function saveLocalProgress() {
    if (!currentTest) return;
    const savedPin = localStorage.getItem('studentPin');
    const progress = {
        qIndex: currentQIndex,
        answers: localAnswers
    };
    localStorage.setItem(`progress_${currentTest.title}_${savedPin}`, JSON.stringify(progress));
}

socket.on('test_results', (data) => {
    // Remove pending message if exists
    const pending = document.getElementById('result-pending-msg');
    if (pending) pending.remove();
    cleanupProgress();

    const existingScore = document.getElementById('final-score-display');
    if (existingScore) existingScore.remove();

    const scoreDisplay = document.createElement('div');
    scoreDisplay.id = 'final-score-display';
    scoreDisplay.style.fontSize = '1.8rem';
    scoreDisplay.style.fontWeight = 'bold';
    scoreDisplay.style.color = 'var(--primary)';
    scoreDisplay.style.margin = '20px 0';
    scoreDisplay.innerText = `Ваша оцінка: ${data.grade12} балів (за 12-бальною шкалою)`;
    // data.score is the raw score if we want to show it: ` (${data.score} з ${data.maxPossible})`
    
    // Check settings sent from server
    const showScore = currentTest && currentTest.settings && currentTest.settings.showScore !== false;
    
    if (showScore) {
        finishedSection.querySelector('h2').after(scoreDisplay);
    }
    
    // Ensure we are in finished section
    testSection.classList.add('hidden');
    finishedSection.classList.remove('hidden');
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
    let pStr = String(provided).trim().toLowerCase().replace(',', '.');
    let aStr = String(actual).trim().toLowerCase().replace(',', '.');
    
    // Support mapping for true_false questions
    if (pStr === 'так') pStr = 'правда';
    if (pStr === 'ні') pStr = 'неправда';

    return pStr === aStr;
}

function showFeedback(isCorrect, correctAnswer) {
    const overlay = document.getElementById('feedback-overlay');
    // ... same logic ...
    const icon = document.getElementById('feedback-icon');
    const text = document.getElementById('feedback-text');
    const correctPara = document.getElementById('feedback-correct-answer');
    
    overlay.classList.remove('hidden');
    icon.innerText = isCorrect ? '✅' : '❌';
    icon.style.color = isCorrect ? 'var(--success)' : 'var(--error)';
    text.innerText = isCorrect ? 'Правильно!' : 'Неправильно';
    
    let displayCorrect = Array.isArray(correctAnswer) ? correctAnswer.join(', ') : correctAnswer;
    if (typeof correctAnswer === 'object' && correctAnswer !== null && !Array.isArray(correctAnswer)) {
        displayCorrect = Object.entries(correctAnswer).map(([k, v]) => `${k} ➔ ${v}`).join('<br>');
    }
    
    const showCorrect = !currentTest || !currentTest.settings || currentTest.settings.showCorrect !== false;
    correctPara.innerHTML = (isCorrect || !showCorrect) ? '' : `Правильна відповідь:<br>${displayCorrect}`;
    renderMath(overlay);
    
    document.getElementById('feedback-next-btn').onclick = () => {
        overlay.classList.add('hidden');
        nextQuestion();
        saveLocalProgress(); // Save after feedback is dismissed
    };
}

function nextQuestion() {
    if (isBreakActive) {
        testSection.classList.add('hidden');
        breakSection.classList.remove('hidden');
        return;
    }
    currentQIndex++;
    renderQuestion();
}

document.getElementById('break-toggle-btn').onclick = () => {
    isBreakActive = !isBreakActive;
    const btn = document.getElementById('break-toggle-btn');
    if (isBreakActive) {
        btn.innerText = '✅ Перерву активовано';
        btn.style.backgroundColor = 'var(--success)';
        btn.style.color = '#fff';
    } else {
        btn.innerText = '⏸️ Перерва';
        btn.style.backgroundColor = '#fff';
        btn.style.color = 'var(--primary)';
    }
};

document.getElementById('resume-test-btn').onclick = () => {
    isBreakActive = false;
    const btn = document.getElementById('break-toggle-btn');
    btn.innerText = '⏸️ Перерва';
    btn.style.backgroundColor = '#fff';
    btn.style.color = 'var(--primary)';
    
    breakSection.classList.add('hidden');
    testSection.classList.remove('hidden');
    
    currentQIndex++;
    renderQuestion();
};

document.getElementById('history-btn').onclick = async () => {
    const container = document.getElementById('history-container');
    const list = document.getElementById('history-list');
    
    if (!container.classList.contains('hidden')) {
        container.classList.add('hidden');
        return;
    }
    
    list.innerHTML = 'Завантаження...';
    container.classList.remove('hidden');
    
    try {
        const token = getStudentToken();
        const res = await fetch(`/api/student/history?token=${token}`);
        const history = await res.json();
        
        if (!history || history.length === 0) {
            list.innerHTML = '<p style="color: #666;">Історія порожня.</p>';
        } else {
            list.innerHTML = history.reverse().map(h => `
                <div style="border-bottom: 1px solid #ccc; padding: 10px 0;">
                    <div style="font-weight: bold; margin-bottom: 4px;">${h.testTitle}</div>
                    <div>Оцінка: <span style="color: var(--success); font-weight: bold; font-size: 1.1rem;">${h.score}</span></div>
                    <div style="color: #666; margin-top: 4px;">${new Date(h.date).toLocaleString('uk-UA')}</div>
                </div>
            `).join('');
        }
    } catch (e) {
        list.innerHTML = '<p style="color: var(--error);">Помилка завантаження історії.</p>';
    }
};

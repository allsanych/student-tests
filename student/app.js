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

function getStudentToken() {
    let token = localStorage.getItem('studentToken');
    if (!token) {
        token = 'std_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
        localStorage.setItem('studentToken', token);
    }
    return token;
}

document.getElementById('join-btn').onclick = (e) => {
    const name = document.getElementById('student-name').value.trim();
    const pin = document.getElementById('student-pin').value.trim();
    if (!name) return alert('Будь ласка, введіть прізвище та ім\'я');
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
    e.target.innerText = 'Приєднуємо...';
    
    // Save to local storage for persistence
    localStorage.setItem('studentName', name);
    localStorage.setItem('studentPin', pin);
    
    socket.emit('student_join', { name, pin, token: getStudentToken() });
};

// Auto-populate
window.addEventListener('load', () => {
    const savedName = localStorage.getItem('studentName');
    const savedPin = localStorage.getItem('studentPin');
    if (savedName) {
        document.getElementById('student-name').value = savedName.replace(/ \(Спроба \d+\)$/, '');
    }
    if (savedPin) {
        document.getElementById('student-pin').value = savedPin;
    }
});

socket.on('join_error', (msg) => { 
    alert(msg); 
    const btn = document.getElementById('join-btn');
    btn.disabled = false;
    btn.innerText = 'Приєднатися (На весь екран)';
});

socket.on('start_test', (test) => {
    currentTest = test;
    currentQIndex = 0;
    joinSection.classList.add('hidden');
    waitingSection.classList.add('hidden');
    testSection.classList.remove('hidden');
    breakSection.classList.add('hidden');
    
    // Update header banner
    const greetingTitle = document.getElementById('greeting-title');
    const greetingText = document.getElementById('greeting-text');
    if (greetingTitle) greetingTitle.innerText = `📝 ${currentTest.title || 'Тестування'}`;
    if (greetingText) greetingText.innerText = `PIN-код: ${localStorage.getItem('studentPin') || '---'}`;
    if (welcomeBanner) welcomeBanner.style.padding = '10px 20px';
    
    // Global test timer check
    if (currentTest.settings && currentTest.settings.timerType === 'total') {
        perQuestionTimer = false;
        startTimer(currentTest.settings.timerValue);
    }
    
    renderQuestion();
});

socket.on('stop_test', () => {
    clearInterval(timerInterval);
    testSection.classList.add('hidden');
    finishedSection.classList.remove('hidden');
    cheatWarningBanner.classList.add('hidden');
    document.getElementById('feedback-overlay').classList.add('hidden');
});

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

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') triggerCheatWarning(); });
window.addEventListener('blur', () => triggerCheatWarning());
window.addEventListener('resize', () => { 
    // More lenient threshold for mobile keyboards
    if (currentTest && window.innerHeight < initialHeight * 0.5) triggerCheatWarning(); 
});

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
        cheatWarningBanner.classList.add('hidden');
        if (!currentTest || !currentTest.questions) {
            testSection.innerHTML = '<div class="card"><h2>Очікування завантаження питань...</h2></div>';
            return;
        }

        const q = currentTest.questions[currentQIndex];
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
            
            inputHtml = `<div class="matching-container" style="display: flex; gap: 10px;">
                <div style="flex: 1;">${lefts.map((l, i) => `<div style="padding: 10px; border: 1px solid var(--primary); margin-bottom: 5px; background: #e0e7ff; border-radius: 8px;">${l}</div>`).join('')}</div>
                <div style="flex: 1;">${lefts.map((l, idx) => `
                    <select id="match-ans-${idx}" style="width: 100%; padding: 10px; margin-bottom: 5px; border-radius: 8px;" data-left="${l}">
                        <option value="">-- Оберіть пару --</option>
                        ${rights.map(r => `<option value="${r}">${r}</option>`).join('')}
                    </select>
                `).join('')}</div>
            </div>
            <button onclick="submitMatching()" style="width: 100%; margin-top: 10px;">Підтвердити</button>`;
        }

        qContainer.innerHTML = `
            <div class="card question-card">
                ${q.image ? `<img src="${q.image}" style="max-width: 100%; max-height: 300px; display: block; margin: 0 auto 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">` : ''}
                <div style="font-size: 1.3rem; margin-bottom: 2rem; line-height: 1.6; user-select: none;" onclick="event.stopPropagation()">${q.text}</div>
                <div id="inputs-container">${inputHtml}</div>
                <div style="margin-top: 20px; border-top: 1px solid #eee; padding-top: 15px;">
                    <button class="secondary" onclick="submitAnswer('ПРОПУЩЕНО')" style="width: 100%; background-color: #f3f4f6; color: #4b5563;">Пропустити питання</button>
                </div>
            </div>
        `;

        if (window.renderMathInElement) {
            renderMathInElement(qContainer, {
                delimiters: [
                    {left: '$$', right: '$$', display: true},
                    {left: '$', right: '$', display: false}
                ],
                throwOnError: false
            });
        }
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
        const select = document.getElementById(`match-ans-${i}`);
        if (!select.value) return alert('Знайдіть пару для всіх елементів');
        ans[select.dataset.left] = select.value;
    }
    submitAnswer(ans);
};

window.submitAnswer = (ans) => {
    if (perQuestionTimer) clearInterval(timerInterval);
    
    const q = currentTest.questions[currentQIndex];
    
    // Fuzzy matching for local feedback
    const isCorrect = checkCorrectness(ans, q.answer);
    
    socket.emit('submit_answer', { questionId: q.id, answer: ans });

    if (currentTest.settings && currentTest.settings.showFeedback) {
        showFeedback(isCorrect, q.answer);
    } else {
        nextQuestion();
    }
};

socket.on('test_results', (data) => {
    // Remove pending message if exists
    const pending = document.getElementById('result-pending-msg');
    if (pending) pending.remove();

    const existingScore = document.getElementById('final-score-display');
    if (existingScore) existingScore.remove();

    const scoreDisplay = document.createElement('div');
    scoreDisplay.id = 'final-score-display';
    scoreDisplay.style.fontSize = '1.8rem';
    scoreDisplay.style.fontWeight = 'bold';
    scoreDisplay.style.color = 'var(--primary)';
    scoreDisplay.style.margin = '20px 0';
    scoreDisplay.innerText = `Ваша оцінка: ${data.score} балів`;
    
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
    
    document.getElementById('feedback-next-btn').onclick = () => {
        overlay.classList.add('hidden');
        nextQuestion();
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

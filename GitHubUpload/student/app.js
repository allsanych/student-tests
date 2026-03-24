const socket = io();
const joinSection = document.getElementById('join-section');
const waitingSection = document.getElementById('waiting-section');
const testSection = document.getElementById('test-section');
const finishedSection = document.getElementById('finished-section');
const cheatWarningBanner = document.getElementById('cheat-warning-banner');
const qContainer = document.getElementById('question-container');

let currentTest = null;
let currentQIndex = 0;
let initialHeight = window.innerHeight;
let timerInterval = null;
let timeLeft = 0;
let perQuestionTimer = false;

document.getElementById('join-btn').onclick = (e) => {
    const name = document.getElementById('student-name').value.trim();
    const pin = document.getElementById('student-pin').value.trim();
    if (!name) return alert('Будь ласка, введіть прізвище та ім\'я');
    
    // Disable button to prevent double clicks
    e.target.disabled = true;
    e.target.innerText = 'Приєднуємо...';
    
    // Save to local storage for persistence
    localStorage.setItem('studentName', name);
    localStorage.setItem('studentPin', pin);
    
    socket.emit('student_join', { name, pin });
};

// Auto-populate and optional auto-join
window.addEventListener('load', () => {
    const savedName = localStorage.getItem('studentName');
    const savedPin = localStorage.getItem('studentPin');
    if (savedName) {
        document.getElementById('student-name').value = savedName;
        if (savedPin) document.getElementById('student-pin').value = savedPin;
        
        // Small delay to ensure socket is connected
        setTimeout(() => {
            if (savedName && socket.connected) {
                socket.emit('student_join', { name: savedName, pin: savedPin });
            }
        }, 1000);
    }
});

socket.on('join_error', (msg) => { alert(msg); });

socket.on('start_test', (test) => {
    currentTest = test;
    currentQIndex = 0;
    joinSection.classList.add('hidden');
    waitingSection.classList.add('hidden');
    testSection.classList.remove('hidden');
    
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
            testSection.innerHTML = '<div class="card"><h2>Всі питання пройдено! Очікуйте завершення...</h2></div>';
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

function checkCorrectness(provided, actual) {
    if (Array.isArray(actual)) {
        if (!Array.isArray(provided)) return false;
        return actual.length === provided.length && actual.every(v => provided.includes(v));
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
    correctPara.innerText = isCorrect ? '' : `Правильна відповідь: ${displayCorrect}`;
    
    document.getElementById('feedback-next-btn').onclick = () => {
        overlay.classList.add('hidden');
        nextQuestion();
    };
}

function nextQuestion() {
    currentQIndex++;
    renderQuestion();
}

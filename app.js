// ============================================================
// Family Chores Tracker - GitHub Gist-backed chore management
// ============================================================

const App = (() => {
    // --- State ---
    let state = {
        token: '',
        gistId: '',
        family: [],    // { id, name, color }
        tasks: [],     // { id, name, category, durationMin }
        schedules: [], // { id, taskId, memberId, frequency, days[] }
        completions: {} // { "YYYY-MM-DD": { scheduleId: true } }
    };

    // --- Gist API ---
    const gist = {
        headers() {
            return {
                'Authorization': `token ${state.token}`,
                'Content-Type': 'application/json'
            };
        },

        async create() {
            const res = await fetch('https://api.github.com/gists', {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({
                    description: 'Family Chores Tracker Data',
                    public: false,
                    files: {
                        'family.json': { content: '[]' },
                        'tasks.json': { content: '[]' },
                        'schedules.json': { content: '[]' },
                        'completions.json': { content: '{}' }
                    }
                })
            });
            if (!res.ok) throw new Error('Failed to create Gist. Check your token.');
            const data = await res.json();
            return data.id;
        },

        async load() {
            const res = await fetch(`https://api.github.com/gists/${state.gistId}`, {
                headers: this.headers()
            });
            if (!res.ok) throw new Error('Failed to load Gist. Check your Gist ID and token.');
            const data = await res.json();
            const parse = (name, fallback) => {
                try {
                    return JSON.parse(data.files[name]?.content || JSON.stringify(fallback));
                } catch { return fallback; }
            };
            state.family = parse('family.json', []);
            state.tasks = parse('tasks.json', []);
            state.schedules = parse('schedules.json', []);
            state.completions = parse('completions.json', {});
        },

        async save() {
            const res = await fetch(`https://api.github.com/gists/${state.gistId}`, {
                method: 'PATCH',
                headers: this.headers(),
                body: JSON.stringify({
                    files: {
                        'family.json': { content: JSON.stringify(state.family, null, 2) },
                        'tasks.json': { content: JSON.stringify(state.tasks, null, 2) },
                        'schedules.json': { content: JSON.stringify(state.schedules, null, 2) },
                        'completions.json': { content: JSON.stringify(state.completions, null, 2) }
                    }
                })
            });
            if (!res.ok) throw new Error('Failed to save data.');
        }
    };

    // --- Helpers ---
    function uid() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    function today() {
        return new Date().toISOString().split('T')[0];
    }

    function dayOfWeek(date) {
        return new Date(date).getDay(); // 0=Sun
    }

    function dayOfMonth(date) {
        return new Date(date).getDate();
    }

    function getDayName(num) {
        return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][num];
    }

    function getTasksForMemberOnDate(memberId, date) {
        const dow = dayOfWeek(date);
        const dom = dayOfMonth(date);
        return state.schedules.filter(s => {
            if (s.memberId !== memberId) return false;
            if (s.frequency === 'daily') return true;
            if (s.frequency === 'weekly') return s.days.includes(dow);
            if (s.frequency === 'monthly') return s.days.includes(dom);
            return false;
        });
    }

    // Completion entry format:
    // Legacy: true (simple check-off)
    // New:    { startedAt, finishedAt, actualMin }
    //   - startedAt only = in progress
    //   - startedAt + finishedAt = completed with time tracked
    //   - { completed: true } = completed without timing (manual check-off)

    function getCompletion(scheduleId, date) {
        const entry = state.completions[date]?.[scheduleId];
        if (!entry) return null;
        if (entry === true) return { completed: true }; // legacy
        return entry;
    }

    function isCompleted(scheduleId, date) {
        const c = getCompletion(scheduleId, date);
        if (!c) return false;
        if (c === true || c.completed) return true;
        return !!(c.finishedAt);
    }

    function isInProgress(scheduleId, date) {
        const c = getCompletion(scheduleId, date);
        if (!c) return false;
        return !!(c.startedAt && !c.finishedAt);
    }

    function startTask(scheduleId, date) {
        if (!state.completions[date]) state.completions[date] = {};
        state.completions[date][scheduleId] = {
            startedAt: Date.now(),
            finishedAt: null,
            actualMin: null
        };
        gist.save();
    }

    function finishTask(scheduleId, date) {
        const entry = state.completions[date]?.[scheduleId];
        if (!entry || !entry.startedAt) return;
        const now = Date.now();
        const elapsed = Math.round((now - entry.startedAt) / 60000 * 10) / 10; // minutes, 1 decimal
        entry.finishedAt = now;
        entry.actualMin = elapsed;
        gist.save();
    }

    function resetTask(scheduleId, date) {
        if (state.completions[date]) {
            delete state.completions[date][scheduleId];
        }
        gist.save();
    }

    function toggleCompletion(scheduleId, date) {
        // Quick complete without timing (for legacy / simple check-off)
        if (!state.completions[date]) state.completions[date] = {};
        if (state.completions[date][scheduleId]) {
            delete state.completions[date][scheduleId];
        } else {
            state.completions[date][scheduleId] = { completed: true };
        }
        gist.save();
    }

    function formatElapsed(ms) {
        const totalSec = Math.floor(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    function getInitials(name) {
        return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    }

    function $(id) { return document.getElementById(id); }
    function $$(sel) { return document.querySelectorAll(sel); }

    // --- Navigation ---
    function showView(viewName) {
        $$('.view').forEach(v => v.classList.add('hidden'));
        $(`${viewName}-view`).classList.remove('hidden');
        $$('.nav-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.view === viewName);
        });
    }

    function showScreen(screenName) {
        $$('.screen').forEach(s => s.classList.add('hidden'));
        $(screenName).classList.remove('hidden');
    }

    // --- Setup ---
    function initSetup() {
        const saved = localStorage.getItem('chores_config');
        if (saved) {
            const config = JSON.parse(saved);
            state.token = config.token;
            state.gistId = config.gistId;
            connectAndLoad();
        }

        $('connect-btn').addEventListener('click', async () => {
            const token = $('gist-token').value.trim();
            const gistId = $('gist-id').value.trim();
            if (!token) {
                $('setup-error').textContent = 'Please enter your GitHub token.';
                $('setup-error').classList.remove('hidden');
                return;
            }
            state.token = token;
            $('connect-btn').textContent = 'Connecting...';
            $('connect-btn').disabled = true;
            try {
                if (gistId) {
                    state.gistId = gistId;
                } else {
                    state.gistId = await gist.create();
                }
                localStorage.setItem('chores_config', JSON.stringify({
                    token: state.token,
                    gistId: state.gistId
                }));
                await connectAndLoad();
            } catch (e) {
                $('setup-error').textContent = e.message;
                $('setup-error').classList.remove('hidden');
                $('connect-btn').textContent = 'Connect';
                $('connect-btn').disabled = false;
            }
        });
    }

    async function connectAndLoad() {
        try {
            await gist.load();
            showScreen('main-app');
            initApp();
        } catch (e) {
            localStorage.removeItem('chores_config');
            $('setup-error').textContent = e.message;
            $('setup-error').classList.remove('hidden');
            showScreen('setup-screen');
            $('connect-btn').textContent = 'Connect';
            $('connect-btn').disabled = false;
        }
    }

    // --- Main App Init ---
    function initApp() {
        initNav();
        initDashboard();
        initFamily();
        initTasks();
        initSchedule();
        initSettings();
        renderDashboard();
    }

    function initNav() {
        $$('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const view = btn.dataset.view;
                showView(view);
                if (view === 'dashboard') renderDashboard();
                if (view === 'family') renderFamily();
                if (view === 'tasks') renderTasks();
                if (view === 'schedule') renderSchedule();
            });
        });
    }

    // --- Dashboard ---
    function initDashboard() {
        $('date-display').textContent = new Date().toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        });
    }

    function renderDashboard() {
        const container = $('dashboard-cards');
        const d = today();

        if (state.family.length === 0) {
            container.innerHTML = '<div class="empty-state"><p>No family members yet.</p><p>Go to <strong>Family</strong> to add members, then <strong>Tasks</strong> to add chores!</p></div>';
            $('weekly-progress').innerHTML = '';
            return;
        }

        container.innerHTML = state.family.map(member => {
            const memberSchedules = getTasksForMemberOnDate(member.id, d);
            const completed = memberSchedules.filter(s => isCompleted(s.id, d)).length;
            const inProgress = memberSchedules.filter(s => isInProgress(s.id, d)).length;
            const total = memberSchedules.length;
            const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
            const color = member.color || '#4A90D9';

            // Calculate time tracked today
            const timeTracked = memberSchedules.reduce((sum, s) => {
                const c = getCompletion(s.id, d);
                return sum + (c?.actualMin || 0);
            }, 0);

            const previewItems = memberSchedules.slice(0, 3).map(s => {
                const task = state.tasks.find(t => t.id === s.taskId);
                const done = isCompleted(s.id, d);
                const prog = isInProgress(s.id, d);
                const icon = done ? '✓' : prog ? '◉' : '○';
                return `<div class="task-preview-item ${done ? 'done' : ''} ${prog ? 'in-prog' : ''}">
                    <span class="check">${icon}</span>
                    <span>${task ? task.name : 'Unknown task'}</span>
                </div>`;
            }).join('');

            const timeText = timeTracked > 0 ? ` · ${Math.round(timeTracked)} min tracked` : '';
            const progText = inProgress > 0 ? ` · ${inProgress} in progress` : '';

            return `<div class="dashboard-card" data-member="${member.id}">
                <div class="card-header">
                    <div class="avatar" style="background:${color}">${getInitials(member.name)}</div>
                    <h3>${member.name}</h3>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width:${pct}%;background:${color}"></div>
                </div>
                <div class="progress-text">${completed}/${total} tasks complete${progText}${timeText}</div>
                <div class="task-preview">${previewItems}</div>
            </div>`;
        }).join('');

        // Click to open member view
        container.querySelectorAll('.dashboard-card').forEach(card => {
            card.addEventListener('click', () => openMemberView(card.dataset.member));
        });

        // Weekly progress
        renderWeeklyProgress();
    }

    function renderWeeklyProgress() {
        const container = $('weekly-progress');
        const d = new Date();
        const startOfWeek = new Date(d);
        startOfWeek.setDate(d.getDate() - d.getDay());

        let weekDates = [];
        for (let i = 0; i < 7; i++) {
            const wd = new Date(startOfWeek);
            wd.setDate(startOfWeek.getDate() + i);
            weekDates.push(wd.toISOString().split('T')[0]);
        }

        container.innerHTML = state.family.map(member => {
            let weekTotal = 0, weekDone = 0;
            weekDates.forEach(date => {
                const schedules = getTasksForMemberOnDate(member.id, date);
                weekTotal += schedules.length;
                weekDone += schedules.filter(s => isCompleted(s.id, date)).length;
            });
            const pct = weekTotal > 0 ? Math.round((weekDone / weekTotal) * 100) : 0;
            return `<div class="weekly-row">
                <span class="weekly-name">${member.name}</span>
                <div class="weekly-bar">
                    <div class="weekly-fill" style="width:${pct}%;background:${member.color}">${pct > 10 ? pct + '%' : ''}</div>
                </div>
                <span class="progress-text">${weekDone}/${weekTotal}</span>
            </div>`;
        }).join('');
    }

    // --- Member View ---
    function openMemberView(memberId) {
        const member = state.family.find(m => m.id === memberId);
        if (!member) return;

        $$('.view').forEach(v => v.classList.add('hidden'));
        $('member-view').classList.remove('hidden');
        $$('.nav-btn').forEach(b => b.classList.remove('active'));

        $('member-header').innerHTML = `
            <div class="avatar" style="background:${member.color}">${getInitials(member.name)}</div>
            <div>
                <h2>${member.name}</h2>
                <span class="date-display">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
            </div>`;

        renderMemberTasks(memberId);

        $('back-to-dashboard').onclick = () => {
            showView('dashboard');
            renderDashboard();
        };
    }

    // Timer interval reference
    let timerInterval = null;

    function renderMemberTasks(memberId) {
        // Clear any existing timer interval
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

        const d = today();
        const schedules = getTasksForMemberOnDate(memberId, d);

        if (schedules.length === 0) {
            $('member-tasks').innerHTML = '<div class="empty-state"><p>No tasks scheduled for today!</p></div>';
            return;
        }

        // Calculate summary
        const totalTasks = schedules.length;
        const doneTasks = schedules.filter(s => isCompleted(s.id, d)).length;
        const totalEstMin = schedules.reduce((sum, s) => {
            const task = state.tasks.find(t => t.id === s.taskId);
            return sum + (task?.durationMin || 0);
        }, 0);
        const totalActualMin = schedules.reduce((sum, s) => {
            const c = getCompletion(s.id, d);
            return sum + (c?.actualMin || 0);
        }, 0);

        let html = `<div class="member-summary">
            <div class="summary-stat">
                <span class="summary-number">${doneTasks}/${totalTasks}</span>
                <span class="summary-label">Tasks Done</span>
            </div>
            ${totalEstMin > 0 ? `<div class="summary-stat">
                <span class="summary-number">${Math.round(totalEstMin)}</span>
                <span class="summary-label">Est. Minutes</span>
            </div>` : ''}
            ${totalActualMin > 0 ? `<div class="summary-stat">
                <span class="summary-number">${Math.round(totalActualMin * 10) / 10}</span>
                <span class="summary-label">Actual Minutes</span>
            </div>` : ''}
        </div>`;

        html += schedules.map(s => {
            const task = state.tasks.find(t => t.id === s.taskId);
            const done = isCompleted(s.id, d);
            const inProg = isInProgress(s.id, d);
            const comp = getCompletion(s.id, d);
            const estDur = task?.durationMin ? `Est: ${task.durationMin} min` : '';

            let statusClass = '';
            let timerHtml = '';
            let actionsHtml = '';

            if (done) {
                statusClass = 'completed';
                const actualTime = comp?.actualMin != null ? `${Math.round(comp.actualMin * 10) / 10} min` : '';
                timerHtml = actualTime ? `<span class="task-actual-time">${actualTime}</span>` : '';
                actionsHtml = `<button class="btn btn-task btn-reset" data-schedule="${s.id}">Reset</button>`;
            } else if (inProg) {
                statusClass = 'in-progress';
                timerHtml = `<span class="task-timer" data-started="${comp.startedAt}">0:00</span>`;
                actionsHtml = `<button class="btn btn-task btn-finish" data-schedule="${s.id}">Finish</button>`;
            } else {
                actionsHtml = `
                    <button class="btn btn-task btn-start" data-schedule="${s.id}">Start</button>
                    <button class="btn btn-task btn-done" data-schedule="${s.id}" title="Complete without timing">✓</button>`;
            }

            return `<div class="member-task-item ${statusClass}" data-schedule="${s.id}">
                <div class="task-left">
                    <div class="checkbox">${done ? '✓' : inProg ? '◉' : ''}</div>
                    <div class="task-details">
                        <span class="task-label">${task ? task.name : 'Unknown'}</span>
                        <span class="task-sub">${estDur}${estDur && s.frequency ? ' · ' : ''}${s.frequency}</span>
                    </div>
                </div>
                <div class="task-right">
                    ${timerHtml}
                    <div class="task-btn-group">${actionsHtml}</div>
                </div>
            </div>`;
        }).join('');

        $('member-tasks').innerHTML = html;

        // Start button handlers
        $('member-tasks').querySelectorAll('.btn-start').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                startTask(btn.dataset.schedule, d);
                renderMemberTasks(memberId);
            });
        });

        // Finish button handlers
        $('member-tasks').querySelectorAll('.btn-finish').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                finishTask(btn.dataset.schedule, d);
                renderMemberTasks(memberId);
            });
        });

        // Quick complete (checkmark) handlers
        $('member-tasks').querySelectorAll('.btn-done').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleCompletion(btn.dataset.schedule, d);
                renderMemberTasks(memberId);
            });
        });

        // Reset button handlers
        $('member-tasks').querySelectorAll('.btn-reset').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                resetTask(btn.dataset.schedule, d);
                renderMemberTasks(memberId);
            });
        });

        // Live timer update
        const hasActiveTimers = schedules.some(s => isInProgress(s.id, d));
        if (hasActiveTimers) {
            timerInterval = setInterval(() => {
                document.querySelectorAll('.task-timer').forEach(el => {
                    const started = parseInt(el.dataset.started);
                    if (started) {
                        el.textContent = formatElapsed(Date.now() - started);
                    }
                });
            }, 1000);
        }
    }

    // --- Family ---
    let editingMemberId = null;
    let selectedColor = '#FF6B6B';

    function initFamily() {
        $('add-member-btn').addEventListener('click', () => {
            editingMemberId = null;
            $('member-modal-title').textContent = 'Add Family Member';
            $('member-name').value = '';
            selectedColor = '#FF6B6B';
            updateColorSelection();
            $('member-modal').classList.remove('hidden');
        });

        $('cancel-member-btn').addEventListener('click', () => {
            $('member-modal').classList.add('hidden');
        });

        $('save-member-btn').addEventListener('click', async () => {
            const name = $('member-name').value.trim();
            if (!name) return;

            if (editingMemberId) {
                const member = state.family.find(m => m.id === editingMemberId);
                if (member) {
                    member.name = name;
                    member.color = selectedColor;
                }
            } else {
                state.family.push({ id: uid(), name, color: selectedColor });
            }
            await gist.save();
            $('member-modal').classList.add('hidden');
            renderFamily();
        });

        $$('.color-swatch').forEach(swatch => {
            swatch.addEventListener('click', () => {
                selectedColor = swatch.dataset.color;
                updateColorSelection();
            });
        });
    }

    function updateColorSelection() {
        $$('.color-swatch').forEach(s => {
            s.classList.toggle('selected', s.dataset.color === selectedColor);
        });
    }

    function renderFamily() {
        if (state.family.length === 0) {
            $('family-list').innerHTML = '<div class="empty-state"><p>No family members yet. Click "Add Member" to get started!</p></div>';
            return;
        }

        $('family-list').innerHTML = state.family.map(m => `
            <div class="family-card">
                <div class="avatar" style="background:${m.color}">${getInitials(m.name)}</div>
                <h3>${m.name}</h3>
                <div class="family-card-actions">
                    <button class="btn btn-small edit-member" data-id="${m.id}">Edit</button>
                    <button class="btn btn-small delete-member" data-id="${m.id}" style="color:var(--danger)">Delete</button>
                </div>
            </div>
        `).join('');

        $$('.edit-member').forEach(btn => {
            btn.addEventListener('click', () => {
                const member = state.family.find(m => m.id === btn.dataset.id);
                if (!member) return;
                editingMemberId = member.id;
                $('member-modal-title').textContent = 'Edit Family Member';
                $('member-name').value = member.name;
                selectedColor = member.color;
                updateColorSelection();
                $('member-modal').classList.remove('hidden');
            });
        });

        $$('.delete-member').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Remove this family member? Their scheduled tasks will also be removed.')) return;
                const id = btn.dataset.id;
                state.family = state.family.filter(m => m.id !== id);
                state.schedules = state.schedules.filter(s => s.memberId !== id);
                await gist.save();
                renderFamily();
            });
        });
    }

    // --- Tasks ---
    let editingTaskId = null;

    function initTasks() {
        $('add-task-btn').addEventListener('click', () => {
            editingTaskId = null;
            $('task-modal-title').textContent = 'Add Task';
            $('task-name').value = '';
            $('task-category').value = 'cleaning';
            $('task-duration').value = '';
            $('task-modal').classList.remove('hidden');
        });

        $('cancel-task-btn').addEventListener('click', () => {
            $('task-modal').classList.add('hidden');
        });

        $('save-task-btn').addEventListener('click', async () => {
            const name = $('task-name').value.trim();
            const category = $('task-category').value;
            const duration = parseFloat($('task-duration').value) || 0;
            if (!name) return;

            if (editingTaskId) {
                const task = state.tasks.find(t => t.id === editingTaskId);
                if (task) {
                    task.name = name;
                    task.category = category;
                    task.durationMin = duration;
                }
            } else {
                state.tasks.push({ id: uid(), name, category, durationMin: duration });
            }
            await gist.save();
            $('task-modal').classList.add('hidden');
            renderTasks();
        });

        // Import
        $('import-tasks-btn').addEventListener('click', () => {
            $('file-input').click();
        });

        $('file-input').addEventListener('change', handleFileImport);
    }

    async function handleFileImport(e) {
        const file = e.target.files[0];
        if (!file) return;

        const ext = file.name.split('.').pop().toLowerCase();

        if (ext === 'csv') {
            const text = await file.text();
            const rows = parseCSVToRows(text);
            importRows(rows);
        } else if (ext === 'xlsx' || ext === 'xls') {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data, { type: 'array' });
            // Try to find the master sheet, otherwise use the first sheet
            const masterName = workbook.SheetNames.find(n =>
                /master/i.test(n)
            ) || workbook.SheetNames[0];
            const sheet = workbook.Sheets[masterName];
            const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
            importRows(rows);
        }
        e.target.value = '';
    }

    function importRows(rows) {
        if (rows.length < 2) {
            alert('No data found in the spreadsheet.');
            return;
        }

        // Detect column indices from header row
        const header = rows[0].map(h => String(h || '').toLowerCase().trim());
        const col = {
            group: header.findIndex(h => /task.?group/i.test(h)),
            name: header.findIndex(h => /description|task.?name|chore/i.test(h)),
            assigned: header.findIndex(h => /assign/i.test(h)),
            frequency: header.findIndex(h => /frequency/i.test(h)),
            duration: header.findIndex(h => /duration/i.test(h)),
        };

        // Fallback: if no "Description" column, use first column as name
        if (col.name === -1) col.name = 0;

        const defaultColors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#FF8C42', '#98D8C8'];
        let colorIdx = 0;

        // Helper: find or create a family member
        function ensureMember(name) {
            const normalized = name.trim();
            if (!normalized) return null;
            let member = state.family.find(m => m.name.toLowerCase() === normalized.toLowerCase());
            if (!member) {
                member = { id: uid(), name: normalized, color: defaultColors[colorIdx % defaultColors.length] };
                colorIdx++;
                state.family.push(member);
            }
            return member;
        }

        // Helper: parse "Assigned To" into individual member names
        function parseAssignees(raw) {
            if (!raw) return [];
            const str = String(raw).trim();
            // Handle "All" — will assign to everyone after all members are known
            if (str.toLowerCase() === 'all') return ['__ALL__'];
            // Handle "Amelie and Stephen", "Stephen and Amelie"
            return str.split(/\s+and\s+/i).map(s => s.trim()).filter(Boolean);
        }

        // Helper: normalize frequency string from spreadsheet
        function normalizeFrequency(raw, group) {
            const str = String(raw || group || '').toLowerCase().trim();
            if (/daily/.test(str)) return 'daily';
            if (/week|bi-week|2x/.test(str)) return 'weekly';
            if (/month|as needed/.test(str)) return 'monthly';
            return 'weekly';
        }

        let importedTasks = 0;
        let importedSchedules = 0;
        let importedMembers = 0;
        const startMembers = state.family.length;

        // First pass: collect all unique member names so "All" works
        const allAssignees = new Set();
        for (let i = 1; i < rows.length; i++) {
            const r = rows[i];
            if (!r || !r[col.name]) continue;
            const assignees = parseAssignees(r[col.assigned]);
            assignees.forEach(a => { if (a !== '__ALL__') allAssignees.add(a); });
        }
        // Ensure all members exist
        allAssignees.forEach(name => ensureMember(name));
        importedMembers = state.family.length - startMembers;

        // Second pass: import tasks and schedules
        for (let i = 1; i < rows.length; i++) {
            const r = rows[i];
            const taskName = r[col.name] ? String(r[col.name]).trim() : '';
            if (!taskName) continue;

            const group = col.group >= 0 ? String(r[col.group] || '').trim() : '';
            const duration = col.duration >= 0 ? parseFloat(r[col.duration]) || 0 : 0;
            const freqRaw = col.frequency >= 0 ? String(r[col.frequency] || '') : '';
            const frequency = normalizeFrequency(freqRaw, group);
            const category = guessCategory(group, taskName);

            // Find or create task
            let task = state.tasks.find(t => t.name.toLowerCase() === taskName.toLowerCase());
            if (!task) {
                task = { id: uid(), name: taskName, category, durationMin: duration };
                state.tasks.push(task);
                importedTasks++;
            }

            // Parse assignees and create schedules
            let assignees = parseAssignees(r[col.assigned]);
            if (assignees.includes('__ALL__')) {
                assignees = state.family.map(m => m.name);
            }

            assignees.forEach(assigneeName => {
                const member = ensureMember(assigneeName);
                if (!member) return;

                // Check for duplicate schedule
                const exists = state.schedules.some(s =>
                    s.taskId === task.id && s.memberId === member.id && s.frequency === frequency
                );
                if (!exists) {
                    state.schedules.push({
                        id: uid(),
                        taskId: task.id,
                        memberId: member.id,
                        frequency: frequency,
                        days: [] // User picks specific days later
                    });
                    importedSchedules++;
                }
            });
        }

        gist.save();
        renderTasks();

        // Build summary message
        const parts = [];
        if (importedMembers > 0) parts.push(`${importedMembers} family member${importedMembers > 1 ? 's' : ''}`);
        if (importedTasks > 0) parts.push(`${importedTasks} task${importedTasks > 1 ? 's' : ''}`);
        if (importedSchedules > 0) parts.push(`${importedSchedules} assignment${importedSchedules > 1 ? 's' : ''}`);

        if (parts.length > 0) {
            alert(`Successfully imported:\n${parts.join('\n')}\n\nGo to Schedule to pick specific days for weekly/monthly tasks.`);
        } else {
            alert('No new data found to import. Everything may already exist.');
        }
    }

    function parseCSVToRows(text) {
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        return lines.map(line => {
            const result = [];
            let current = '';
            let inQuotes = false;
            for (const char of line) {
                if (char === '"') { inQuotes = !inQuotes; }
                else if (char === ',' && !inQuotes) { result.push(current); current = ''; }
                else { current += char; }
            }
            result.push(current);
            return result;
        });
    }

    function guessCategory(group, name) {
        // Use the spreadsheet's Task Group first
        const g = (group || '').toLowerCase();
        if (g === 'daily' || g === 'weekly' || g === 'monthly') {
            // Task Group is frequency, not category — guess from name
        } else if (g) {
            // If the group is a real category name, use it
            if (['cleaning', 'kitchen', 'laundry', 'outdoor', 'pets', 'other'].includes(g)) return g;
        }
        const n = name.toLowerCase();
        if (/dish|cook|kitchen|meal|food|lunch|dinner|coffee|fridge|stove|microwave|cabinet|grocer/.test(n)) return 'kitchen';
        if (/laundry|wash(?!.*dog)|fold|iron|clothes|sheet|towel|bedding|dry.*transfer/.test(n)) return 'laundry';
        if (/mow|yard|garden|rake|snow|garage|trash|recycl|grass|weed|patio|deck|outdoor|bin|curb|shed/.test(n)) return 'outdoor';
        if (/pet|dog|cat|feed.*dog|litter|walk.*dog|groom|brush.*dog|bowl/.test(n)) return 'pets';
        if (/vacuum|mop|dust|clean|sweep|wipe|scrub|tidy|bath|clutter|surface|switch|handle/.test(n)) return 'cleaning';
        return 'other';
    }

    function renderTasks() {
        if (state.tasks.length === 0) {
            $('tasks-list').innerHTML = '<div class="empty-state"><p>No tasks yet. Add tasks manually or import from a spreadsheet!</p></div>';
            return;
        }

        $('tasks-list').innerHTML = state.tasks.map(t => `
            <div class="task-item">
                <div class="task-info">
                    <span class="task-category-badge cat-${t.category}">${t.category}</span>
                    <span>${t.name}</span>
                    ${t.durationMin ? `<span class="task-duration">${t.durationMin} min</span>` : ''}
                </div>
                <div class="task-actions">
                    <button class="btn btn-small edit-task" data-id="${t.id}">Edit</button>
                    <button class="btn btn-small delete-task" data-id="${t.id}" style="color:var(--danger)">Delete</button>
                </div>
            </div>
        `).join('');

        $$('.edit-task').forEach(btn => {
            btn.addEventListener('click', () => {
                const task = state.tasks.find(t => t.id === btn.dataset.id);
                if (!task) return;
                editingTaskId = task.id;
                $('task-modal-title').textContent = 'Edit Task';
                $('task-name').value = task.name;
                $('task-category').value = task.category;
                $('task-duration').value = task.durationMin || '';
                $('task-modal').classList.remove('hidden');
            });
        });

        $$('.delete-task').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this task? Any schedules using it will also be removed.')) return;
                const id = btn.dataset.id;
                state.tasks = state.tasks.filter(t => t.id !== id);
                state.schedules = state.schedules.filter(s => s.taskId !== id);
                await gist.save();
                renderTasks();
            });
        });
    }

    // --- Schedule ---
    let selectedDays = [];
    let editingScheduleId = null;

    function initSchedule() {
        $('assign-frequency').addEventListener('change', renderDayPicker);

        $('cancel-assign-btn').addEventListener('click', () => {
            $('assign-modal').classList.add('hidden');
        });

        $('save-assign-btn').addEventListener('click', async () => {
            const taskId = $('assign-task').value;
            const memberId = $('assign-member').value;
            const frequency = $('assign-frequency').value;

            if (!taskId || !memberId) return;

            if (editingScheduleId) {
                const schedule = state.schedules.find(s => s.id === editingScheduleId);
                if (schedule) {
                    schedule.taskId = taskId;
                    schedule.memberId = memberId;
                    schedule.frequency = frequency;
                    schedule.days = [...selectedDays];
                }
            } else {
                state.schedules.push({
                    id: uid(),
                    taskId,
                    memberId,
                    frequency,
                    days: [...selectedDays]
                });
            }
            await gist.save();
            $('assign-modal').classList.add('hidden');
            renderSchedule();
        });

        $('schedule-member-filter').addEventListener('change', renderSchedule);
    }

    function openAssignModal(scheduleToEdit) {
        editingScheduleId = scheduleToEdit ? scheduleToEdit.id : null;

        // Populate dropdowns
        $('assign-task').innerHTML = state.tasks.map(t =>
            `<option value="${t.id}" ${scheduleToEdit && scheduleToEdit.taskId === t.id ? 'selected' : ''}>${t.name}</option>`
        ).join('');

        $('assign-member').innerHTML = state.family.map(m =>
            `<option value="${m.id}" ${scheduleToEdit && scheduleToEdit.memberId === m.id ? 'selected' : ''}>${m.name}</option>`
        ).join('');

        if (scheduleToEdit) {
            $('assign-frequency').value = scheduleToEdit.frequency;
            selectedDays = [...scheduleToEdit.days];
        } else {
            $('assign-frequency').value = 'weekly';
            selectedDays = [];
        }

        renderDayPicker();
        $('assign-modal').classList.remove('hidden');
    }

    function renderDayPicker() {
        const freq = $('assign-frequency').value;
        const container = $('day-options');

        if (freq === 'daily') {
            $('day-picker').classList.add('hidden');
            return;
        }

        $('day-picker').classList.remove('hidden');

        if (freq === 'weekly') {
            container.innerHTML = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) =>
                `<span class="day-option ${selectedDays.includes(i) ? 'selected' : ''}" data-day="${i}">${d}</span>`
            ).join('');
        } else {
            container.innerHTML = Array.from({ length: 31 }, (_, i) =>
                `<span class="day-option ${selectedDays.includes(i + 1) ? 'selected' : ''}" data-day="${i + 1}">${i + 1}</span>`
            ).join('');
        }

        container.querySelectorAll('.day-option').forEach(opt => {
            opt.addEventListener('click', () => {
                const day = parseInt(opt.dataset.day);
                if (selectedDays.includes(day)) {
                    selectedDays = selectedDays.filter(d => d !== day);
                } else {
                    selectedDays.push(day);
                }
                opt.classList.toggle('selected');
            });
        });
    }

    function renderSchedule() {
        // Update filter dropdown
        const filter = $('schedule-member-filter');
        const currentVal = filter.value;
        filter.innerHTML = '<option value="all">All Members</option>' +
            state.family.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
        filter.value = currentVal;

        const filteredSchedules = currentVal === 'all'
            ? state.schedules
            : state.schedules.filter(s => s.memberId === currentVal);

        if (state.tasks.length === 0 || state.family.length === 0) {
            $('schedule-content').innerHTML = '<div class="empty-state"><p>Add family members and tasks first, then assign tasks here.</p></div>';
            return;
        }

        if (filteredSchedules.length === 0) {
            $('schedule-content').innerHTML = `
                <div class="empty-state">
                    <p>No tasks scheduled yet.</p>
                    <button class="btn btn-primary" id="first-assign-btn">+ Assign a Task</button>
                </div>`;
            $('first-assign-btn')?.addEventListener('click', () => openAssignModal());
            return;
        }

        // Group by frequency
        const groups = { daily: [], weekly: [], monthly: [] };
        filteredSchedules.forEach(s => {
            if (groups[s.frequency]) groups[s.frequency].push(s);
        });

        let html = '';
        for (const [freq, items] of Object.entries(groups)) {
            if (items.length === 0) continue;
            html += `<div class="schedule-section">
                <h3>
                    <span><span class="frequency-badge freq-${freq}">${freq}</span> Tasks</span>
                    <button class="btn btn-small add-schedule-btn">+ Assign</button>
                </h3>`;
            items.forEach(s => {
                const task = state.tasks.find(t => t.id === s.taskId);
                const member = state.family.find(m => m.id === s.memberId);
                let daysText = '';
                if (freq === 'weekly') daysText = s.days.map(d => getDayName(d)).join(', ');
                if (freq === 'monthly') daysText = s.days.map(d => `${d}${ordinal(d)}`).join(', ');

                html += `<div class="schedule-item">
                    <div class="schedule-item-info">
                        <span class="schedule-member-badge" style="background:${member?.color || '#999'}">${member?.name || '?'}</span>
                        <span>${task?.name || 'Unknown task'}</span>
                        ${daysText ? `<span class="schedule-days">(${daysText})</span>` : ''}
                    </div>
                    <div class="task-actions">
                        <button class="btn btn-small edit-schedule" data-id="${s.id}">Edit</button>
                        <button class="btn btn-small delete-schedule" data-id="${s.id}" style="color:var(--danger)">Remove</button>
                    </div>
                </div>`;
            });
            html += '</div>';
        }

        // Add a floating assign button if there are already schedules
        html += `<div style="text-align:center;margin-top:12px;">
            <button class="btn btn-primary add-schedule-btn">+ Assign a Task</button>
        </div>`;

        $('schedule-content').innerHTML = html;

        $$('.add-schedule-btn').forEach(btn => {
            btn.addEventListener('click', () => openAssignModal());
        });

        $$('.edit-schedule').forEach(btn => {
            btn.addEventListener('click', () => {
                const schedule = state.schedules.find(s => s.id === btn.dataset.id);
                if (schedule) openAssignModal(schedule);
            });
        });

        $$('.delete-schedule').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Remove this scheduled task?')) return;
                state.schedules = state.schedules.filter(s => s.id !== btn.dataset.id);
                await gist.save();
                renderSchedule();
            });
        });
    }

    function ordinal(n) {
        const s = ['th', 'st', 'nd', 'rd'];
        const v = n % 100;
        return s[(v - 20) % 10] || s[v] || s[0];
    }

    // --- Settings ---
    function initSettings() {
        $('settings-btn').addEventListener('click', () => {
            $('settings-gist-id').value = state.gistId;
            $('settings-modal').classList.remove('hidden');
        });

        $('close-settings-btn').addEventListener('click', () => {
            $('settings-modal').classList.add('hidden');
        });

        $('copy-gist-id').addEventListener('click', () => {
            navigator.clipboard.writeText(state.gistId);
            $('copy-gist-id').textContent = 'Copied!';
            setTimeout(() => $('copy-gist-id').textContent = 'Copy', 1500);
        });

        $('disconnect-btn').addEventListener('click', () => {
            if (!confirm('Disconnect? Your data will remain in the Gist.')) return;
            localStorage.removeItem('chores_config');
            state = { token: '', gistId: '', family: [], tasks: [], schedules: [], completions: {} };
            showScreen('setup-screen');
            $('gist-token').value = '';
            $('gist-id').value = '';
            $('connect-btn').textContent = 'Connect';
            $('connect-btn').disabled = false;
        });
    }

    // --- Boot ---
    document.addEventListener('DOMContentLoaded', initSetup);
})();

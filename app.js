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
        return localDateStr(new Date());
    }

    function dayOfWeek(date) {
        // Parse YYYY-MM-DD as local time (not UTC)
        const [y, m, d] = date.split('-').map(Number);
        return new Date(y, m - 1, d).getDay(); // 0=Sun
    }

    function dayOfMonth(date) {
        const [, , d] = date.split('-').map(Number);
        return d;
    }

    function getDayName(num) {
        return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][num];
    }

    function getTasksForMemberOnDate(memberId, date) {
        const dow = dayOfWeek(date);
        const dom = dayOfMonth(date);
        const results = [];
        state.schedules.forEach(s => {
            if (s.memberId !== memberId) return;
            let applies = false;
            if (s.frequency === 'daily' || s.frequency === 'recurring') applies = true;
            else if (s.frequency === 'weekly') applies = s.days.includes(dow);
            else if (s.frequency === 'monthly') {
                // If no specific days picked, show as flexible (any day this month)
                applies = (!s.days || s.days.length === 0) ? true : s.days.includes(dom);
            }
            if (!applies) return;

            // For daily/recurring tasks with multiple time-of-day slots, expand into separate entries
            if ((s.frequency === 'daily' || s.frequency === 'recurring') && s.timeOfDay && s.timeOfDay.length > 1) {
                s.timeOfDay.forEach(tod => {
                    results.push({
                        ...s,
                        _tod: tod,
                        _compositeId: `${s.id}_${tod}` // Unique ID per time slot
                    });
                });
            } else {
                results.push({
                    ...s,
                    _tod: s.timeOfDay?.[0] || null,
                    _compositeId: s.id
                });
            }
        });

        // Sort by time of day: morning first, then afternoon, then evening, then unset
        const todOrder = { morning: 0, afternoon: 1, evening: 2 };
        results.sort((a, b) => {
            const aOrd = a._tod ? (todOrder[a._tod] ?? 3) : 3;
            const bOrd = b._tod ? (todOrder[b._tod] ?? 3) : 3;
            return aOrd - bOrd;
        });

        return results;
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

    // Completion entry now supports:
    //   startedAt, finishedAt, actualMin (as before)
    //   pausedAt - timestamp when paused (null if running)
    //   pausedTotal - cumulative ms spent paused

    function startTask(scheduleId, date) {
        if (!state.completions[date]) state.completions[date] = {};
        state.completions[date][scheduleId] = {
            startedAt: Date.now(),
            finishedAt: null,
            actualMin: null,
            pausedAt: null,
            pausedTotal: 0
        };
        gist.save();
    }

    function pauseTask(scheduleId, date) {
        const entry = state.completions[date]?.[scheduleId];
        if (!entry || !entry.startedAt || entry.finishedAt) return;
        if (entry.pausedAt) return; // already paused
        entry.pausedAt = Date.now();
        gist.save();
    }

    function resumeTask(scheduleId, date) {
        const entry = state.completions[date]?.[scheduleId];
        if (!entry || !entry.pausedAt) return;
        entry.pausedTotal = (entry.pausedTotal || 0) + (Date.now() - entry.pausedAt);
        entry.pausedAt = null;
        gist.save();
    }

    function isPaused(scheduleId, date) {
        const c = getCompletion(scheduleId, date);
        return !!(c?.startedAt && !c?.finishedAt && c?.pausedAt);
    }

    function getActiveElapsed(entry) {
        if (!entry || !entry.startedAt) return 0;
        const now = entry.finishedAt || Date.now();
        const totalMs = now - entry.startedAt;
        const pausedMs = (entry.pausedTotal || 0) + (entry.pausedAt ? (Date.now() - entry.pausedAt) : 0);
        return totalMs - pausedMs;
    }

    function finishTask(scheduleId, date) {
        const entry = state.completions[date]?.[scheduleId];
        if (!entry || !entry.startedAt) return;
        // If paused, resume first to account for final pause time
        if (entry.pausedAt) {
            entry.pausedTotal = (entry.pausedTotal || 0) + (Date.now() - entry.pausedAt);
            entry.pausedAt = null;
        }
        const now = Date.now();
        const activeMs = now - entry.startedAt - (entry.pausedTotal || 0);
        const actualMin = Math.round(activeMs / 60000 * 10) / 10;

        // Check if this is a recurring task — if so, log time and reset for next use
        const schedule = state.schedules.find(s => s.id === scheduleId) ||
            state.schedules.find(s => scheduleId.startsWith(s.id)); // handle composite IDs

        if (schedule && isRecurringEntry(schedule)) {
            // Append to time logs instead of marking complete
            if (!entry.timeLogs) entry.timeLogs = [];
            entry.timeLogs.push({ startedAt: entry.startedAt, finishedAt: now, actualMin });
            // Reset the timer state so it can be started again
            entry.startedAt = null;
            entry.finishedAt = null;
            entry.actualMin = null;
            entry.pausedAt = null;
            entry.pausedTotal = 0;
        } else {
            entry.finishedAt = now;
            entry.actualMin = actualMin;
        }

        // Update estimated time based on rolling average
        const task = schedule ? state.tasks.find(t => t.id === schedule.taskId) : null;
        if (task) updateEstimatedTime(task);

        gist.save();
    }

    function getTimeLogs(scheduleId, date) {
        const entry = state.completions[date]?.[scheduleId];
        if (!entry) return [];
        return entry.timeLogs || [];
    }

    // Check if a schedule entry is recurring (either task flag or schedule frequency)
    function isRecurringEntry(schedule) {
        if (schedule.frequency === 'recurring') return true;
        const task = state.tasks.find(t => t.id === schedule.taskId);
        return !!task?.isRecurring;
    }

    // Update a task's estimated time based on rolling average of actual completions
    function updateEstimatedTime(task) {
        if (!task) return;
        const actuals = [];
        // Scan recent completions for this task (last 30 days)
        const now = new Date();
        for (let i = 0; i < 30; i++) {
            const d = new Date(now);
            d.setDate(now.getDate() - i);
            const dateStr = localDateStr(d);
            const dayCompletions = state.completions[dateStr];
            if (!dayCompletions) continue;
            // Find all schedules for this task
            state.schedules.filter(s => s.taskId === task.id).forEach(s => {
                const entry = dayCompletions[s.id];
                if (entry?.actualMin && entry.actualMin > 0) {
                    actuals.push(entry.actualMin);
                }
                // Also check composite IDs for daily tasks
                if (entry?.timeLogs) {
                    entry.timeLogs.forEach(l => {
                        if (l.actualMin > 0) actuals.push(l.actualMin);
                    });
                }
            });
        }
        if (actuals.length >= 2) {
            // Use rolling average, rounded to nearest 0.5
            const avg = actuals.reduce((s, v) => s + v, 0) / actuals.length;
            task.durationMin = Math.round(avg * 2) / 2;
        }
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

    function renderAvatar(member) {
        if (member.photo) {
            return `<div class="avatar has-photo" style="background:${member.color}"><img src="${member.photo}" alt="${member.name}"></div>`;
        }
        return `<div class="avatar" style="background:${member.color}">${getInitials(member.name)}</div>`;
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
        initReports();
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
                if (view === 'reports') renderReports();
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
            const cid = s => s._compositeId || s.id;

            // Separate regular vs recurring
            const regular = memberSchedules.filter(s => !isRecurringEntry(s));
            const recurring = memberSchedules.filter(s => isRecurringEntry(s));

            const completed = regular.filter(s => isCompleted(cid(s), d)).length;
            const inProgress = memberSchedules.filter(s => isInProgress(cid(s), d)).length;
            const total = regular.length;
            const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
            const color = member.color || '#4A90D9';

            // Calculate time tracked today (regular + recurring)
            const timeTracked = regular.reduce((sum, s) => {
                const c = getCompletion(cid(s), d);
                return sum + (c?.actualMin || 0);
            }, 0);
            const recurringTime = recurring.reduce((sum, s) => {
                const logs = getTimeLogs(cid(s), d);
                return sum + logs.reduce((ls, l) => ls + (l.actualMin || 0), 0);
            }, 0);
            const totalTimeTracked = timeTracked + recurringTime;

            const previewItems = memberSchedules.slice(0, 4).map(s => {
                const task = state.tasks.find(t => t.id === s.taskId);
                const isRec = isRecurringEntry(s);
                const done = isCompleted(cid(s), d);
                const prog = isInProgress(cid(s), d);
                const icon = isRec ? '↻' : done ? '✓' : prog ? '◉' : '○';
                return `<div class="task-preview-item ${done ? 'done' : ''} ${prog ? 'in-prog' : ''}">
                    <span class="check">${icon}</span>
                    <span>${task ? task.name : 'Unknown task'}</span>
                </div>`;
            }).join('');

            const timeText = totalTimeTracked > 0 ? ` · ${Math.round(totalTimeTracked)} min tracked` : '';
            const progText = inProgress > 0 ? ` · ${inProgress} in progress` : '';
            const recurText = recurring.length > 0 ? ` · ${recurring.length} recurring` : '';

            return `<div class="dashboard-card" data-member="${member.id}">
                <div class="card-header">
                    ${renderAvatar(member)}
                    <h3>${member.name}</h3>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width:${pct}%;background:${color}"></div>
                </div>
                <div class="progress-text">${completed}/${total} tasks complete${progText}${recurText}${timeText}</div>
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
            weekDates.push(localDateStr(wd));
        }

        container.innerHTML = state.family.map(member => {
            let weekTotal = 0, weekDone = 0;
            weekDates.forEach(date => {
                const schedules = getTasksForMemberOnDate(member.id, date);
                weekTotal += schedules.length;
                weekDone += schedules.filter(s => isCompleted(s._compositeId || s.id, date)).length;
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
            ${renderAvatar(member)}
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

        // Helper for composite IDs (daily tasks with multiple time slots)
        const cid = s => s._compositeId || s.id;

        // Calculate summary — separate regular tasks from recurring
        const regularSchedules = schedules.filter(s => !isRecurringEntry(s));
        const recurringSchedules = schedules.filter(s => isRecurringEntry(s));

        const totalTasks = regularSchedules.length;
        const doneTasks = regularSchedules.filter(s => isCompleted(cid(s), d)).length;
        const totalEstMin = regularSchedules.reduce((sum, s) => {
            const task = state.tasks.find(t => t.id === s.taskId);
            return sum + (task?.durationMin || 0);
        }, 0);
        const totalActualMin = regularSchedules.reduce((sum, s) => {
            const c = getCompletion(cid(s), d);
            return sum + (c?.actualMin || 0);
        }, 0);

        // Recurring time logged today
        const recurringTimeMin = recurringSchedules.reduce((sum, s) => {
            const logs = getTimeLogs(cid(s), d);
            return sum + logs.reduce((ls, l) => ls + (l.actualMin || 0), 0);
        }, 0);
        const recurringCount = recurringSchedules.length;

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
            ${recurringCount > 0 ? `<div class="summary-stat">
                <span class="summary-number">${recurringCount}</span>
                <span class="summary-label">Recurring</span>
            </div>` : ''}
            ${recurringTimeMin > 0 ? `<div class="summary-stat">
                <span class="summary-number">${Math.round(recurringTimeMin * 10) / 10}</span>
                <span class="summary-label">Recurring Min</span>
            </div>` : ''}
        </div>`;

        html += schedules.map(s => {
            const sid = cid(s);
            const task = state.tasks.find(t => t.id === s.taskId);
            const done = isCompleted(sid, d);
            const inProg = isInProgress(sid, d);
            const comp = getCompletion(sid, d);
            const estDur = task?.durationMin ? `Est: ${task.durationMin} min` : '';
            const todLabel = s._tod ? s._tod.charAt(0).toUpperCase() + s._tod.slice(1) : '';

            let statusClass = '';
            let timerHtml = '';
            let actionsHtml = '';

            const paused = isPaused(sid, d);

            const isRecurring = isRecurringEntry(s);

            if (isRecurring) {
                // Recurring tasks: show time log entries + Log button
                const logs = getTimeLogs(sid, d);
                const totalLogged = logs.reduce((sum, l) => sum + (l.actualMin || 0), 0);
                const logCount = logs.length;

                if (inProg || paused) {
                    statusClass = 'in-progress';
                    const elapsed = getActiveElapsed(comp);
                    timerHtml = `<span class="task-timer ${paused ? 'paused' : ''}" data-schedule-id="${sid}">${formatElapsed(elapsed)}</span>`;
                    if (paused) {
                        actionsHtml = `
                            <button class="btn btn-task btn-resume" data-schedule="${sid}">Resume</button>
                            <button class="btn btn-task btn-finish" data-schedule="${sid}">Log</button>
                            <button class="btn btn-task btn-cancel" data-schedule="${sid}">Cancel</button>`;
                    } else {
                        actionsHtml = `
                            <button class="btn btn-task btn-pause" data-schedule="${sid}">Pause</button>
                            <button class="btn btn-task btn-finish" data-schedule="${sid}">Log</button>
                            <button class="btn btn-task btn-cancel" data-schedule="${sid}">Cancel</button>`;
                    }
                } else {
                    timerHtml = totalLogged > 0
                        ? `<span class="task-actual-time">${logCount}x · ${Math.round(totalLogged)} min</span>`
                        : '';
                    actionsHtml = `<button class="btn btn-task btn-start" data-schedule="${sid}">Log Time</button>`;
                }
            } else if (done) {
                statusClass = 'completed';
                const actualTime = comp?.actualMin != null ? `${Math.round(comp.actualMin * 10) / 10} min` : '';
                timerHtml = actualTime ? `<span class="task-actual-time">${actualTime}</span>` : '';
                actionsHtml = `<button class="btn btn-task btn-reset" data-schedule="${sid}">Reset</button>`;
            } else if (inProg || paused) {
                statusClass = paused ? 'in-progress' : 'in-progress';
                const elapsed = getActiveElapsed(comp);
                timerHtml = `<span class="task-timer ${paused ? 'paused' : ''}" data-schedule-id="${sid}">${formatElapsed(elapsed)}</span>`;
                if (paused) {
                    actionsHtml = `
                        <button class="btn btn-task btn-resume" data-schedule="${sid}">Resume</button>
                        <button class="btn btn-task btn-finish" data-schedule="${sid}">Finish</button>
                        <button class="btn btn-task btn-cancel" data-schedule="${sid}">Cancel</button>`;
                } else {
                    actionsHtml = `
                        <button class="btn btn-task btn-pause" data-schedule="${sid}">Pause</button>
                        <button class="btn btn-task btn-finish" data-schedule="${sid}">Finish</button>
                        <button class="btn btn-task btn-cancel" data-schedule="${sid}">Cancel</button>`;
                }
            } else {
                const estMin = task?.durationMin || '';
                actionsHtml = `
                    <div class="manual-time-group">
                        <input type="number" class="manual-time-input" data-schedule="${sid}" placeholder="${estMin || 'min'}" min="0" step="0.5" title="Enter minutes manually">
                        <button class="btn btn-task btn-done" data-schedule="${sid}" title="Complete with entered time (or estimated)">✓</button>
                    </div>
                    <button class="btn btn-task btn-start" data-schedule="${sid}">Start</button>`;
            }

            const todBadge = todLabel ? `<span class="tod-badge tod-${s._tod}">${todLabel}</span>` : '';
            const recurBadge = isRecurring ? '<span class="tod-badge tod-recurring">Recurring</span>' : '';
            const checkIcon = isRecurring ? '↻' : (done ? '✓' : (inProg || paused) ? '◉' : '');

            return `<div class="member-task-item ${statusClass} ${isRecurring ? 'recurring' : ''}" data-schedule="${sid}">
                <div class="task-left">
                    <div class="checkbox ${isRecurring ? 'recurring-check' : ''}">${checkIcon}</div>
                    <div class="task-details">
                        <span class="task-label">${todBadge}${recurBadge}${task ? task.name : 'Unknown'}</span>
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

        // Quick complete (checkmark) handlers — with optional manual time
        $('member-tasks').querySelectorAll('.btn-done').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sid = btn.dataset.schedule;
                const input = $('member-tasks').querySelector(`.manual-time-input[data-schedule="${sid}"]`);
                const manualMin = input ? parseFloat(input.value) : NaN;

                // Find the task to get estimated time as fallback
                const schedule = state.schedules.find(s => s.id === sid) ||
                    state.schedules.find(s => sid.startsWith(s.id));
                const task = schedule ? state.tasks.find(t => t.id === schedule.taskId) : null;

                if (!state.completions[d]) state.completions[d] = {};

                if (!isNaN(manualMin) && manualMin > 0) {
                    // Manual time entered
                    state.completions[d][sid] = {
                        startedAt: Date.now() - manualMin * 60000,
                        finishedAt: Date.now(),
                        actualMin: manualMin,
                        pausedAt: null,
                        pausedTotal: 0
                    };
                } else if (task?.durationMin) {
                    // No manual time — use estimated time
                    state.completions[d][sid] = {
                        startedAt: Date.now() - task.durationMin * 60000,
                        finishedAt: Date.now(),
                        actualMin: task.durationMin,
                        pausedAt: null,
                        pausedTotal: 0
                    };
                } else {
                    // No time at all — simple completion
                    state.completions[d][sid] = { completed: true };
                }

                // Update estimated time based on average of actual times
                if (task && (manualMin > 0 || task.durationMin)) {
                    updateEstimatedTime(task);
                }

                gist.save();
                renderMemberTasks(memberId);
            });
        });

        // Pause button handlers
        $('member-tasks').querySelectorAll('.btn-pause').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                pauseTask(btn.dataset.schedule, d);
                renderMemberTasks(memberId);
            });
        });

        // Resume button handlers
        $('member-tasks').querySelectorAll('.btn-resume').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                resumeTask(btn.dataset.schedule, d);
                renderMemberTasks(memberId);
            });
        });

        // Cancel button handlers (cancel without logging)
        $('member-tasks').querySelectorAll('.btn-cancel').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                resetTask(btn.dataset.schedule, d);
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

        // Live timer update (only for non-paused timers)
        const hasActiveTimers = schedules.some(s => isInProgress(cid(s), d) && !isPaused(cid(s), d));
        if (hasActiveTimers) {
            timerInterval = setInterval(() => {
                document.querySelectorAll('.task-timer:not(.paused)').forEach(el => {
                    const schedId = el.dataset.scheduleId;
                    if (schedId) {
                        const comp = getCompletion(schedId, d);
                        if (comp && comp.startedAt && !comp.pausedAt) {
                            el.textContent = formatElapsed(getActiveElapsed(comp));
                        }
                    }
                });
            }, 1000);
        }
    }

    // --- Family ---
    let editingMemberId = null;
    let selectedColor = '#FF6B6B';
    let selectedPhoto = null; // base64 data URL or null

    function updateAvatarPreview() {
        const preview = $('avatar-preview');
        const removeBtn = $('remove-avatar-btn');
        if (selectedPhoto) {
            preview.innerHTML = `<img src="${selectedPhoto}" alt="Photo">`;
            removeBtn.classList.remove('hidden');
        } else {
            preview.innerHTML = '<span id="avatar-preview-text">No photo</span>';
            removeBtn.classList.add('hidden');
        }
    }

    function initFamily() {
        $('add-member-btn').addEventListener('click', () => {
            editingMemberId = null;
            $('member-modal-title').textContent = 'Add Family Member';
            $('member-name').value = '';
            selectedColor = '#FF6B6B';
            selectedPhoto = null;
            updateColorSelection();
            updateAvatarPreview();
            $('member-modal').classList.remove('hidden');
        });

        $('cancel-member-btn').addEventListener('click', () => {
            $('member-modal').classList.add('hidden');
        });

        // Photo upload handler
        $('avatar-file').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            // Resize to keep gist size manageable (max 128px)
            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const size = 128;
                    canvas.width = size;
                    canvas.height = size;
                    const ctx = canvas.getContext('2d');
                    // Crop to square center
                    const minDim = Math.min(img.width, img.height);
                    const sx = (img.width - minDim) / 2;
                    const sy = (img.height - minDim) / 2;
                    ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);
                    selectedPhoto = canvas.toDataURL('image/jpeg', 0.7);
                    updateAvatarPreview();
                };
                img.src = ev.target.result;
            };
            reader.readAsDataURL(file);
            e.target.value = '';
        });

        $('remove-avatar-btn').addEventListener('click', () => {
            selectedPhoto = null;
            updateAvatarPreview();
        });

        $('save-member-btn').addEventListener('click', async () => {
            const name = $('member-name').value.trim();
            if (!name) return;

            if (editingMemberId) {
                const member = state.family.find(m => m.id === editingMemberId);
                if (member) {
                    member.name = name;
                    member.color = selectedColor;
                    member.photo = selectedPhoto || null;
                }
            } else {
                state.family.push({ id: uid(), name, color: selectedColor, photo: selectedPhoto || null });
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
                ${renderAvatar(m)}
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
                selectedPhoto = member.photo || null;
                updateColorSelection();
                updateAvatarPreview();
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
            $('task-recurring').checked = false;
            $('task-modal').classList.remove('hidden');
        });

        $('cancel-task-btn').addEventListener('click', () => {
            $('task-modal').classList.add('hidden');
        });

        $('tasks-filter').addEventListener('change', renderTasks);
        $('tasks-member-filter').addEventListener('change', renderTasks);

        $('save-task-btn').addEventListener('click', async () => {
            const name = $('task-name').value.trim();
            const category = $('task-category').value;
            const duration = parseFloat($('task-duration').value) || 0;
            const isRecurring = $('task-recurring').checked;
            if (!name) return;

            if (editingTaskId) {
                const task = state.tasks.find(t => t.id === editingTaskId);
                if (task) {
                    task.name = name;
                    task.category = category;
                    task.durationMin = duration;
                    task.isRecurring = isRecurring;
                }
            } else {
                state.tasks.push({ id: uid(), name, category, durationMin: duration, isRecurring });
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

    function getTaskScheduleStatus(taskId) {
        const schedules = state.schedules.filter(s => s.taskId === taskId);
        if (schedules.length === 0) return 'unscheduled';
        // Check if any weekly/monthly schedule has no days picked
        const needsDays = schedules.some(s =>
            (s.frequency === 'weekly' || s.frequency === 'monthly') && (!s.days || s.days.length === 0)
        );
        if (needsDays) return 'no-days';
        return 'scheduled';
    }

    function renderTasks() {
        const filterVal = $('tasks-filter')?.value || 'all';

        // Populate and read member filter
        const memberDropdown = $('tasks-member-filter');
        const currentMemberVal = memberDropdown.value;
        memberDropdown.innerHTML = '<option value="all">All Members</option>' +
            state.family.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
        memberDropdown.value = currentMemberVal;
        const memberFilterVal = memberDropdown.value;

        if (state.tasks.length === 0) {
            $('tasks-list').innerHTML = '<div class="empty-state"><p>No tasks yet. Add tasks manually or import from a spreadsheet!</p></div>';
            $('tasks-filter-info').classList.add('hidden');
            return;
        }

        // Filter tasks by type/status
        let filtered = state.tasks;
        if (filterVal === 'unscheduled') {
            filtered = state.tasks.filter(t => getTaskScheduleStatus(t.id) === 'unscheduled');
        } else if (filterVal === 'no-days') {
            filtered = state.tasks.filter(t => getTaskScheduleStatus(t.id) === 'no-days');
        } else if (filterVal === 'recurring') {
            filtered = state.tasks.filter(t =>
                t.isRecurring || state.schedules.some(s => s.taskId === t.id && s.frequency === 'recurring')
            );
        } else if (['cleaning', 'kitchen', 'laundry', 'outdoor', 'pets', 'other'].includes(filterVal)) {
            filtered = state.tasks.filter(t => t.category === filterVal);
        }

        // Sub-filter by member
        if (memberFilterVal !== 'all') {
            const memberTaskIds = new Set(
                state.schedules.filter(s => s.memberId === memberFilterVal).map(s => s.taskId)
            );
            filtered = filtered.filter(t => memberTaskIds.has(t.id));
        }

        // Show filter info
        const info = $('tasks-filter-info');
        if (filterVal !== 'all' || memberFilterVal !== 'all') {
            const total = state.tasks.length;
            const memberName = memberFilterVal !== 'all'
                ? state.family.find(m => m.id === memberFilterVal)?.name || ''
                : '';
            const memberText = memberName ? ` for ${memberName}` : '';
            info.textContent = `Showing ${filtered.length} of ${total} tasks${memberText}`;
            info.classList.remove('hidden');
        } else {
            info.classList.add('hidden');
        }

        if (filtered.length === 0) {
            $('tasks-list').innerHTML = `<div class="empty-state"><p>No tasks match this filter.</p></div>`;
            return;
        }

        $('tasks-list').innerHTML = filtered.map(t => {
            const status = getTaskScheduleStatus(t.id);
            const statusBadge = status === 'unscheduled'
                ? '<span class="status-badge status-unscheduled">Unscheduled</span>'
                : status === 'no-days'
                ? '<span class="status-badge status-nodays">Needs Days</span>'
                : '';
            const assignees = state.schedules
                .filter(s => s.taskId === t.id)
                .map(s => state.family.find(m => m.id === s.memberId)?.name)
                .filter(Boolean);
            const assigneeText = assignees.length > 0 ? assignees.join(', ') : '';

            const hasRecurringSchedule = t.isRecurring || state.schedules.some(s => s.taskId === t.id && s.frequency === 'recurring');
            const recurringBadge = hasRecurringSchedule ? '<span class="tod-badge tod-recurring">Recurring</span>' : '';

            const showScheduleBtn = status === 'unscheduled' || status === 'no-days';

            return `<div class="task-item">
                <div class="task-info">
                    <span class="task-category-badge cat-${t.category}">${t.category}</span>
                    <span>${t.name}</span>
                    ${recurringBadge}
                    ${t.durationMin ? `<span class="task-duration">${t.durationMin} min</span>` : ''}
                    ${statusBadge}
                    ${assigneeText ? `<span class="task-assignee">${assigneeText}</span>` : ''}
                </div>
                <div class="task-actions">
                    ${showScheduleBtn ? `<button class="btn btn-small schedule-task-btn" data-id="${t.id}" style="color:var(--primary);border-color:var(--primary)">Schedule</button>` : ''}
                    <button class="btn btn-small edit-task" data-id="${t.id}">Edit</button>
                    <button class="btn btn-small delete-task" data-id="${t.id}" style="color:var(--danger)">Delete</button>
                </div>
            </div>`;
        }).join('');

        $$('.edit-task').forEach(btn => {
            btn.addEventListener('click', () => {
                const task = state.tasks.find(t => t.id === btn.dataset.id);
                if (!task) return;
                editingTaskId = task.id;
                $('task-modal-title').textContent = 'Edit Task';
                $('task-name').value = task.name;
                $('task-category').value = task.category;
                $('task-duration').value = task.durationMin || '';
                $('task-recurring').checked = !!task.isRecurring;
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

        // Schedule button — opens assign modal pre-filled with this task
        $$('.schedule-task-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                _afterAssignCallback = renderTasks;
                openAssignModal(null, { taskId: btn.dataset.id });
            });
        });
    }

    // --- Schedule ---
    let selectedDays = [];
    let selectedTimeOfDay = [];
    let editingScheduleId = null;

    function initSchedule() {
        $('assign-frequency').addEventListener('change', () => {
            renderDayPicker();
            renderTimeOfDayPicker();
        });

        // Time of day toggle handlers
        $$('#time-of-day-options .day-option').forEach(opt => {
            opt.addEventListener('click', () => {
                const tod = opt.dataset.tod;
                if (selectedTimeOfDay.includes(tod)) {
                    selectedTimeOfDay = selectedTimeOfDay.filter(t => t !== tod);
                } else {
                    selectedTimeOfDay.push(tod);
                }
                opt.classList.toggle('selected');
            });
        });

        $('cancel-assign-btn').addEventListener('click', () => {
            $('assign-modal').classList.add('hidden');
        });

        $('save-assign-btn').addEventListener('click', async () => {
            const taskId = $('assign-task').value;
            const memberId = $('assign-member').value;
            const frequency = $('assign-frequency').value;

            if (!taskId || !memberId) return;

            const timeOfDay = (frequency === 'daily' || frequency === 'recurring') ? [...selectedTimeOfDay] : [];

            if (editingScheduleId) {
                const schedule = state.schedules.find(s => s.id === editingScheduleId);
                if (schedule) {
                    schedule.taskId = taskId;
                    schedule.memberId = memberId;
                    schedule.frequency = frequency;
                    schedule.days = [...selectedDays];
                    schedule.timeOfDay = timeOfDay;
                }
            } else {
                state.schedules.push({
                    id: uid(),
                    taskId,
                    memberId,
                    frequency,
                    days: [...selectedDays],
                    timeOfDay
                });
            }
            await gist.save();
            $('assign-modal').classList.add('hidden');
            renderSchedule();
            // Also refresh tasks view if it was open (to update status badges)
            if (_afterAssignCallback) { _afterAssignCallback(); _afterAssignCallback = null; }
        });

        $('schedule-member-filter').addEventListener('change', renderSchedule);
        $('schedule-status-filter').addEventListener('change', renderSchedule);
    }

    let _afterAssignCallback = null;

    // preselect: optional { taskId, memberId } to pre-fill for quick scheduling from Tasks view
    function openAssignModal(scheduleToEdit, preselect) {
        editingScheduleId = scheduleToEdit ? scheduleToEdit.id : null;

        const preTaskId = preselect?.taskId || (scheduleToEdit?.taskId);
        const preMemberId = preselect?.memberId || (scheduleToEdit?.memberId);

        // Populate dropdowns (tasks sorted alphabetically)
        const sortedTasks = [...state.tasks].sort((a, b) => a.name.localeCompare(b.name));
        $('assign-task').innerHTML = sortedTasks.map(t =>
            `<option value="${t.id}" ${preTaskId === t.id ? 'selected' : ''}>${t.name}</option>`
        ).join('');

        $('assign-member').innerHTML = state.family.map(m =>
            `<option value="${m.id}" ${preMemberId === m.id ? 'selected' : ''}>${m.name}</option>`
        ).join('');

        if (scheduleToEdit) {
            $('assign-frequency').value = scheduleToEdit.frequency;
            selectedDays = [...(scheduleToEdit.days || [])];
            selectedTimeOfDay = [...(scheduleToEdit.timeOfDay || [])];
        } else {
            $('assign-frequency').value = 'weekly';
            selectedDays = [];
            selectedTimeOfDay = [];
        }

        renderDayPicker();
        renderTimeOfDayPicker();
        $('assign-modal').classList.remove('hidden');
    }

    function renderTimeOfDayPicker() {
        const freq = $('assign-frequency').value;
        const picker = $('time-of-day-picker');
        if (freq === 'daily' || freq === 'recurring') {
            picker.classList.remove('hidden');
            $$('#time-of-day-options .day-option').forEach(opt => {
                opt.classList.toggle('selected', selectedTimeOfDay.includes(opt.dataset.tod));
            });
        } else {
            picker.classList.add('hidden');
        }
    }

    function renderDayPicker() {
        const freq = $('assign-frequency').value;
        const container = $('day-options');

        if (freq === 'daily' || freq === 'recurring') {
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
        // Update member filter dropdown
        const filter = $('schedule-member-filter');
        const currentVal = filter.value;
        filter.innerHTML = '<option value="all">All Members</option>' +
            state.family.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
        filter.value = currentVal;

        const statusFilter = $('schedule-status-filter').value;

        if (state.tasks.length === 0 || state.family.length === 0) {
            $('schedule-content').innerHTML = '<div class="empty-state"><p>Add family members and tasks first, then assign tasks here.</p></div>';
            return;
        }

        let html = '';

        // === Show unassigned / needs-days tasks ===
        if (statusFilter === 'unassigned' || statusFilter === 'no-days' || statusFilter === 'needs-attention') {
            let unschedTasks;
            let sectionTitle;
            if (statusFilter === 'unassigned') {
                unschedTasks = state.tasks.filter(t => getTaskScheduleStatus(t.id) === 'unscheduled');
                sectionTitle = 'Unassigned Tasks';
            } else if (statusFilter === 'no-days') {
                unschedTasks = state.tasks.filter(t => getTaskScheduleStatus(t.id) === 'no-days');
                sectionTitle = 'Tasks Needing Days Picked';
            } else {
                // "needs-attention" — show both unassigned and needs-days
                unschedTasks = state.tasks.filter(t => {
                    const s = getTaskScheduleStatus(t.id);
                    return s === 'unscheduled' || s === 'no-days';
                });
                sectionTitle = 'Tasks Needing Attention';
            }

            // Sub-filter by member (only for needs-days, since unassigned has no member)
            if (currentVal !== 'all' && statusFilter !== 'unassigned') {
                const memberTaskIds = new Set(
                    state.schedules.filter(s => s.memberId === currentVal).map(s => s.taskId)
                );
                unschedTasks = unschedTasks.filter(t => memberTaskIds.has(t.id));
            }

            if (unschedTasks.length > 0) {
                html += `<div class="schedule-section">
                    <h3><span>${sectionTitle} (${unschedTasks.length})</span></h3>`;
                unschedTasks.forEach(t => {
                    const status = getTaskScheduleStatus(t.id);
                    const assignees = state.schedules
                        .filter(s => s.taskId === t.id)
                        .map(s => state.family.find(m => m.id === s.memberId)?.name)
                        .filter(Boolean);
                    const assigneeText = assignees.length > 0 ? assignees.join(', ') : '';
                    const statusBadge = status === 'unscheduled'
                        ? '<span class="status-badge status-unscheduled">Unassigned</span>'
                        : '<span class="status-badge status-nodays">Needs Days</span>';

                    html += `<div class="schedule-item">
                        <div class="schedule-item-info">
                            <span class="task-category-badge cat-${t.category}">${t.category}</span>
                            <span>${t.name}</span>
                            ${statusBadge}
                            ${assigneeText ? `<span class="task-assignee">${assigneeText}</span>` : ''}
                        </div>
                        <div class="task-actions">
                            <button class="btn btn-small schedule-task-btn" data-id="${t.id}" style="color:var(--primary);border-color:var(--primary)">Assign</button>
                        </div>
                    </div>`;
                });
                html += '</div>';
            } else {
                html += '<div class="empty-state"><p>No tasks match this filter.</p></div>';
            }
        }

        // === Show existing schedules ===
        if (statusFilter === 'scheduled' || statusFilter === 'needs-attention') {
            const filteredSchedules = currentVal === 'all'
                ? state.schedules
                : state.schedules.filter(s => s.memberId === currentVal);

            if (filteredSchedules.length === 0 && statusFilter === 'scheduled') {
                html += `
                    <div class="empty-state">
                        <p>No tasks scheduled yet.</p>
                        <button class="btn btn-primary" id="first-assign-btn">+ Assign a Task</button>
                    </div>`;
            } else if (filteredSchedules.length > 0) {
                // Group by frequency
                const groups = { daily: [], weekly: [], monthly: [], recurring: [] };
                filteredSchedules.forEach(s => {
                    if (groups[s.frequency]) groups[s.frequency].push(s);
                });

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
                        if (freq === 'monthly') {
                            daysText = s.days.length > 0
                                ? s.days.map(d => `${d}${ordinal(d)}`).join(', ')
                                : 'Flexible (any day)';
                        }

                        html += `<div class="schedule-item">
                            <div class="schedule-item-info">
                                ${member ? renderAvatar(member) : '<span class="schedule-member-badge" style="background:#999">?</span>'}
                                <span class="schedule-member-name">${member?.name || '?'}</span>
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
            }

            // Add assign button
            html += `<div style="text-align:center;margin-top:12px;">
                <button class="btn btn-primary add-schedule-btn">+ Assign a Task</button>
            </div>`;
        }

        $('schedule-content').innerHTML = html;

        // Wire up handlers
        $('first-assign-btn')?.addEventListener('click', () => openAssignModal());

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

        // Schedule buttons for unscheduled/needs-days tasks
        $$('#schedule-content .schedule-task-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                _afterAssignCallback = renderSchedule;
                openAssignModal(null, { taskId: btn.dataset.id });
            });
        });
    }

    function ordinal(n) {
        const s = ['th', 'st', 'nd', 'rd'];
        const v = n % 100;
        return s[(v - 20) % 10] || s[v] || s[0];
    }

    // --- Reports ---
    function initReports() {
        $('reports-member-filter').addEventListener('change', renderReports);
        $('reports-period').addEventListener('change', renderReports);
    }

    function localDateStr(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function getDateRange(period) {
        const now = new Date();
        const todayStr = localDateStr(now);

        if (period === 'today') {
            return [todayStr, todayStr];
        }
        if (period === 'week') {
            const start = new Date(now);
            start.setDate(now.getDate() - now.getDay());
            const end = new Date(start);
            end.setDate(start.getDate() + 6);
            return [localDateStr(start), localDateStr(end)];
        }
        if (period === 'month') {
            const start = new Date(now.getFullYear(), now.getMonth(), 1);
            const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
            return [localDateStr(start), localDateStr(end)];
        }
        // all-time: scan all dates in completions
        const dates = Object.keys(state.completions).sort();
        if (dates.length === 0) return [todayStr, todayStr];
        return [dates[0], todayStr];
    }

    function getDatesInRange(start, end) {
        const dates = [];
        const current = new Date(start + 'T00:00:00');
        const endDate = new Date(end + 'T00:00:00');
        while (current <= endDate) {
            const y = current.getFullYear();
            const m = String(current.getMonth() + 1).padStart(2, '0');
            const d = String(current.getDate()).padStart(2, '0');
            dates.push(`${y}-${m}-${d}`);
            current.setDate(current.getDate() + 1);
        }
        return dates;
    }

    function renderReports() {
        // Update filter dropdown
        const memberFilter = $('reports-member-filter');
        const currentMember = memberFilter.value;
        memberFilter.innerHTML = '<option value="all">All Members</option>' +
            state.family.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
        memberFilter.value = currentMember;

        const period = $('reports-period').value;
        const [startDate, endDate] = getDateRange(period);
        const dates = getDatesInRange(startDate, endDate);

        const members = currentMember === 'all'
            ? state.family
            : state.family.filter(m => m.id === currentMember);

        if (members.length === 0) {
            $('reports-content').innerHTML = '<div class="empty-state"><p>No family members to report on.</p></div>';
            return;
        }

        let html = '';

        // ===== 1. Overview Cards =====
        html += '<div class="report-section"><h3>Overview</h3><div class="report-cards">';
        const memberStats = []; // collect for charts below
        members.forEach(member => {
            let totalAssigned = 0;
            let totalCompleted = 0;
            let totalEstMin = 0;
            let totalActualMin = 0;
            let totalRecurringMin = 0;

            dates.forEach(date => {
                const daySchedules = getTasksForMemberOnDate(member.id, date);
                daySchedules.forEach(s => {
                    const task = state.tasks.find(t => t.id === s.taskId);
                    const sid = s._compositeId || s.id;
                    if (isRecurringEntry(s)) {
                        const logs = getTimeLogs(sid, date);
                        totalRecurringMin += logs.reduce((sum, l) => sum + (l.actualMin || 0), 0);
                    } else {
                        totalAssigned++;
                        if (isCompleted(sid, date)) {
                            totalCompleted++;
                            const c = getCompletion(sid, date);
                            if (c?.actualMin) totalActualMin += c.actualMin;
                        }
                        if (task?.durationMin) totalEstMin += task.durationMin;
                    }
                });
            });

            const pct = totalAssigned > 0 ? Math.round((totalCompleted / totalAssigned) * 100) : 0;
            const estHrs = Math.round(totalEstMin / 60 * 10) / 10;
            const actHrs = Math.round(totalActualMin / 60 * 10) / 10;
            const recurHrs = Math.round(totalRecurringMin / 60 * 10) / 10;
            const timeDiff = totalActualMin > 0 && totalEstMin > 0
                ? Math.round(totalActualMin - totalEstMin) : null;
            const timeDiffText = timeDiff !== null
                ? (timeDiff > 0 ? `+${timeDiff} min over` : `${Math.abs(timeDiff)} min under`)
                : '';
            const timeDiffClass = timeDiff !== null
                ? (timeDiff > 0 ? 'over' : 'under') : '';

            memberStats.push({ member, totalAssigned, totalCompleted, totalEstMin, totalActualMin, totalRecurringMin, pct });

            html += `<div class="report-card">
                <div class="report-card-header">
                    ${renderAvatar(member)}
                    <h4>${member.name}</h4>
                </div>
                <div class="report-stats">
                    <div class="report-stat">
                        <span class="stat-value">${totalAssigned}</span>
                        <span class="stat-label">Assigned</span>
                    </div>
                    <div class="report-stat">
                        <span class="stat-value">${totalCompleted}</span>
                        <span class="stat-label">Completed</span>
                    </div>
                    <div class="report-stat">
                        <span class="stat-value">${pct}%</span>
                        <span class="stat-label">Rate</span>
                    </div>
                    <div class="report-stat">
                        <span class="stat-value">${estHrs}h</span>
                        <span class="stat-label">Est. Time</span>
                    </div>
                    <div class="report-stat">
                        <span class="stat-value">${actHrs}h</span>
                        <span class="stat-label">Actual Time</span>
                    </div>
                    ${totalRecurringMin > 0 ? `<div class="report-stat">
                        <span class="stat-value">${recurHrs}h</span>
                        <span class="stat-label">Recurring</span>
                    </div>` : ''}
                </div>
                ${timeDiffText ? `<div class="time-diff ${timeDiffClass}">${timeDiffText} estimate</div>` : ''}
                <div class="progress-bar" style="margin-top:10px">
                    <div class="progress-fill" style="width:${pct}%;background:${member.color}"></div>
                </div>
            </div>`;
        });
        html += '</div></div>';

        // ===== 2. Completion Rate Chart (bar chart) =====
        if (members.length > 1) {
            html += '<div class="report-section"><h3>Completion Rate Comparison</h3>';
            html += '<div class="chart-container"><div class="bar-chart">';
            const maxAssigned = Math.max(...memberStats.map(s => s.totalAssigned), 1);
            memberStats.forEach(({ member, totalAssigned, totalCompleted, pct }) => {
                const completedH = Math.round((totalCompleted / maxAssigned) * 100);
                const remainH = Math.round(((totalAssigned - totalCompleted) / maxAssigned) * 100);
                html += `<div class="bar-group">
                    <div class="bar-value">${pct}%</div>
                    <div class="bar" style="height:${remainH}%;background:${member.color};opacity:0.25" title="${totalAssigned - totalCompleted} remaining"></div>
                    <div class="bar" style="height:${completedH}%;background:${member.color}" title="${totalCompleted} completed"></div>
                    <div class="bar-label">${member.name}</div>
                </div>`;
            });
            html += '</div>';
            html += `<div class="chart-legend">
                <span class="legend-item"><span class="legend-dot" style="background:var(--primary)"></span> Completed</span>
                <span class="legend-item"><span class="legend-dot" style="background:var(--primary);opacity:0.25"></span> Remaining</span>
            </div>`;
            html += '</div></div>';
        }

        // ===== 3. Time Comparison Chart (Est vs Actual) =====
        if (memberStats.some(s => s.totalActualMin > 0)) {
            html += '<div class="report-section"><h3>Estimated vs Actual Time</h3>';
            html += '<div class="chart-container"><div class="bar-chart">';
            const maxTime = Math.max(...memberStats.map(s => Math.max(s.totalEstMin, s.totalActualMin)), 1);
            memberStats.forEach(({ member, totalEstMin, totalActualMin }) => {
                const estH = Math.round((totalEstMin / maxTime) * 100);
                const actH = Math.round((totalActualMin / maxTime) * 100);
                html += `<div class="bar-group" style="flex:2">
                    <div class="bar-value">${Math.round(totalEstMin)}m</div>
                    <div class="bar" style="height:${estH}%;background:${member.color};opacity:0.4" title="${Math.round(totalEstMin)} min estimated"></div>
                    <div class="bar-label">${member.name} Est</div>
                </div>
                <div class="bar-group" style="flex:2">
                    <div class="bar-value">${Math.round(totalActualMin)}m</div>
                    <div class="bar" style="height:${actH}%;background:${member.color}" title="${Math.round(totalActualMin)} min actual"></div>
                    <div class="bar-label">${member.name} Act</div>
                </div>`;
            });
            html += '</div>';
            html += `<div class="chart-legend">
                <span class="legend-item"><span class="legend-dot" style="background:var(--primary);opacity:0.4"></span> Estimated</span>
                <span class="legend-item"><span class="legend-dot" style="background:var(--primary)"></span> Actual</span>
            </div>`;
            html += '</div></div>';
        }

        // ===== 4. Category Donut Chart =====
        const catTotals = {};
        dates.forEach(date => {
            members.forEach(member => {
                const daySchedules = getTasksForMemberOnDate(member.id, date);
                daySchedules.forEach(s => {
                    const task = state.tasks.find(t => t.id === s.taskId);
                    if (!task) return;
                    const sid = s._compositeId || s.id;
                    const cat = task.category || 'other';
                    if (!catTotals[cat]) catTotals[cat] = { est: 0, actual: 0, count: 0, completed: 0 };
                    catTotals[cat].count++;
                    catTotals[cat].est += task.durationMin || 0;
                    if (!isRecurringEntry(s) && isCompleted(sid, date)) {
                        catTotals[cat].completed++;
                        const c = getCompletion(sid, date);
                        if (c?.actualMin) catTotals[cat].actual += c.actualMin;
                    }
                });
            });
        });

        const catColors = {
            cleaning: '#10B981', kitchen: '#F59E0B', laundry: '#3B82F6',
            outdoor: '#84CC16', pets: '#EC4899', other: '#8B5CF6'
        };
        const catEntries = Object.entries(catTotals);
        const totalTasks = catEntries.reduce((s, [, d]) => s + d.count, 0);

        if (catEntries.length > 0) {
            html += '<div class="report-section"><h3>Tasks by Category</h3>';
            html += '<div class="donut-container">';

            // SVG donut chart
            const radius = 60;
            const circumference = 2 * Math.PI * radius;
            let offset = 0;
            let donutPaths = '';
            catEntries.forEach(([cat, data]) => {
                const pct = totalTasks > 0 ? data.count / totalTasks : 0;
                const dashLen = pct * circumference;
                const dashGap = circumference - dashLen;
                donutPaths += `<circle cx="80" cy="80" r="${radius}" fill="none" stroke="${catColors[cat] || '#8B5CF6'}"
                    stroke-width="20" stroke-dasharray="${dashLen} ${dashGap}"
                    stroke-dashoffset="${-offset}" />`;
                offset += dashLen;
            });

            html += `<div class="donut-chart">
                <svg width="160" height="160" viewBox="0 0 160 160">${donutPaths}</svg>
                <div class="donut-center">
                    <span class="donut-value">${totalTasks}</span>
                    <span class="donut-label">Total Tasks</span>
                </div>
            </div>`;

            html += '<div class="donut-legend">';
            catEntries.forEach(([cat, data]) => {
                const pct = totalTasks > 0 ? Math.round((data.count / totalTasks) * 100) : 0;
                html += `<div class="donut-legend-item">
                    <span class="donut-legend-dot" style="background:${catColors[cat] || '#8B5CF6'}"></span>
                    <span>${cat.charAt(0).toUpperCase() + cat.slice(1)}</span>
                    <span class="donut-legend-value">${data.count} (${pct}%)</span>
                </div>`;
            });
            html += '</div></div>';

            // Category time breakdown bars
            html += '<div class="category-breakdown" style="margin-top:20px">';
            const maxEst = Math.max(...Object.values(catTotals).map(c => c.est), 1);
            for (const [cat, data] of catEntries) {
                const barWidth = Math.round((data.est / maxEst) * 100);
                html += `<div class="cat-row">
                    <span class="task-category-badge cat-${cat}">${cat}</span>
                    <div class="cat-bar-wrap">
                        <div class="cat-bar" style="width:${barWidth}%">
                            <span class="cat-bar-label">${Math.round(data.est)} min est</span>
                        </div>
                        ${data.actual > 0 ? `<div class="cat-bar actual" style="width:${Math.round((data.actual / maxEst) * 100)}%">
                            <span class="cat-bar-label">${Math.round(data.actual)} min actual</span>
                        </div>` : ''}
                    </div>
                    <span class="cat-stats">${data.completed}/${data.count}</span>
                </div>`;
            }
            html += '</div></div>';
        }

        // ===== 5. Daily Activity Heatmap =====
        if (dates.length > 1) {
            html += '<div class="report-section"><h3>Daily Activity</h3>';
            html += '<p class="report-desc">Task completions per day — darker = more tasks completed.</p>';
            html += '<div class="streak-grid">';
            const dailyCounts = dates.map(date => {
                let count = 0;
                members.forEach(member => {
                    const daySchedules = getTasksForMemberOnDate(member.id, date);
                    daySchedules.forEach(s => {
                        const sid = s._compositeId || s.id;
                        if (isCompleted(sid, date)) count++;
                    });
                });
                return { date, count };
            });
            const maxDaily = Math.max(...dailyCounts.map(d => d.count), 1);
            dailyCounts.forEach(({ date, count }) => {
                const intensity = count > 0 ? Math.max(0.15, count / maxDaily) : 0;
                const bg = count > 0 ? `rgba(99,102,241,${intensity})` : 'var(--border)';
                const dayName = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                html += `<div class="streak-cell" style="background:${bg}" title="${dayName}: ${count} tasks"></div>`;
            });
            html += '</div>';
            html += `<div class="chart-legend" style="margin-top:8px">
                <span class="legend-item"><span class="legend-dot" style="background:var(--border)"></span> 0</span>
                <span class="legend-item"><span class="legend-dot" style="background:rgba(99,102,241,0.3)"></span> Low</span>
                <span class="legend-item"><span class="legend-dot" style="background:rgba(99,102,241,0.6)"></span> Medium</span>
                <span class="legend-item"><span class="legend-dot" style="background:rgba(99,102,241,1)"></span> High</span>
            </div>`;
            html += '</div>';
        }

        // ===== 6. Weekly Task Tracker Table =====
        html += '<div class="report-section"><h3>Weekly Task Tracker</h3>';
        html += '<p class="report-desc">Track progress on tasks — shows completions and time this week vs. expected.</p>';

        const now = new Date();
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay());
        const weekDates = [];
        for (let i = 0; i < 7; i++) {
            const wd = new Date(weekStart);
            wd.setDate(weekStart.getDate() + i);
            weekDates.push(localDateStr(wd));
        }

        members.forEach(member => {
            const memberSchedules = state.schedules.filter(s => s.memberId === member.id);
            if (memberSchedules.length === 0) return;

            const taskMap = new Map();
            memberSchedules.forEach(s => {
                const task = state.tasks.find(t => t.id === s.taskId);
                if (!task || isRecurringEntry(s)) return; // recurring tracked separately

                if (!taskMap.has(task.id)) {
                    taskMap.set(task.id, {
                        task,
                        schedules: [],
                        expectedPerWeek: 0,
                        estMinPerOccurrence: task.durationMin || 0
                    });
                }
                const entry = taskMap.get(task.id);
                entry.schedules.push(s);

                if (s.frequency === 'daily') {
                    entry.expectedPerWeek += 7;
                } else if (s.frequency === 'weekly') {
                    entry.expectedPerWeek += Math.max(s.days?.length || 1, 1);
                } else if (s.frequency === 'monthly') {
                    entry.expectedPerWeek += (s.days?.length || 1) * 0.25;
                }
            });

            if (taskMap.size === 0) return;

            html += `<div class="report-member-block">
                <h4 style="color:${member.color}">${member.name}</h4>
                <div class="freq-table">
                    <div class="freq-header">
                        <span class="freq-col-task">Task</span>
                        <span class="freq-col">Done</span>
                        <span class="freq-col">Expected</span>
                        <span class="freq-col">Time Used</span>
                        <span class="freq-col">Est. Time</span>
                        <span class="freq-col">Progress</span>
                    </div>`;

            taskMap.forEach(({ task, schedules, expectedPerWeek, estMinPerOccurrence }) => {
                let weekCompletions = 0;
                let weekActualMin = 0;

                weekDates.forEach(date => {
                    schedules.forEach(s => {
                        const dow = dayOfWeek(date);
                        const dom = dayOfMonth(date);
                        let applies = false;
                        if (s.frequency === 'daily') applies = true;
                        else if (s.frequency === 'weekly') applies = s.days.includes(dow);
                        else if (s.frequency === 'monthly') applies = s.days.includes(dom);

                        if (applies && isCompleted(s.id, date)) {
                            weekCompletions++;
                            const c = getCompletion(s.id, date);
                            if (c?.actualMin) weekActualMin += c.actualMin;
                        }
                    });
                });

                const expectedRounded = Math.round(expectedPerWeek * 10) / 10;
                const totalEstMin = Math.round(expectedPerWeek * estMinPerOccurrence);
                const pct = expectedPerWeek > 0 ? Math.min(100, Math.round((weekCompletions / expectedPerWeek) * 100)) : 0;
                const actualFormatted = weekActualMin > 0 ? `${Math.round(weekActualMin)} min` : '-';
                const estFormatted = totalEstMin > 0 ? `${totalEstMin} min` : '-';
                const barColor = pct >= 100 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : member.color;

                html += `<div class="freq-row">
                    <span class="freq-col-task">${task.name}</span>
                    <span class="freq-col">${weekCompletions}</span>
                    <span class="freq-col">${expectedRounded}</span>
                    <span class="freq-col">${actualFormatted}</span>
                    <span class="freq-col">${estFormatted}</span>
                    <span class="freq-col">
                        <div class="mini-bar"><div class="mini-fill" style="width:${pct}%;background:${barColor}"></div></div>
                        <span class="mini-pct">${pct}%</span>
                    </span>
                </div>`;
            });

            html += '</div></div>';
        });
        html += '</div>';

        // ===== 7. Recurring Tasks Summary =====
        const hasRecurring = state.schedules.some(s => isRecurringEntry(s)) || state.tasks.some(t => t.isRecurring);
        if (hasRecurring) {
            html += '<div class="report-section"><h3>Recurring Tasks Summary</h3>';
            html += '<p class="report-desc">Time logged for recurring tasks (never marked as "done").</p>';
            html += '<div class="recurring-summary">';

            members.forEach(member => {
                const memberSchedules = state.schedules.filter(s => s.memberId === member.id);
                memberSchedules.forEach(s => {
                    if (!isRecurringEntry(s)) return;
                    const task = state.tasks.find(t => t.id === s.taskId);
                    if (!task) return;

                    let totalLogged = 0;
                    let totalSessions = 0;
                    dates.forEach(date => {
                        const dayTasks = getTasksForMemberOnDate(member.id, date);
                        dayTasks.forEach(dt => {
                            if (dt.taskId !== task.id) return;
                            const sid = dt._compositeId || dt.id;
                            const logs = getTimeLogs(sid, date);
                            totalSessions += logs.length;
                            totalLogged += logs.reduce((sum, l) => sum + (l.actualMin || 0), 0);
                        });
                    });

                    if (totalSessions === 0 && dates.length <= 1) {
                        // Show even if no sessions for today view
                    }

                    html += `<div class="recurring-row">
                        ${renderAvatar(member)}
                        <span class="schedule-member-name">${member.name}</span>
                        <span class="task-name">${task.name}</span>
                        <div class="recurring-stat">
                            <span class="recurring-stat-value">${totalSessions}</span>
                            <span class="recurring-stat-label">Sessions</span>
                        </div>
                        <div class="recurring-stat">
                            <span class="recurring-stat-value">${Math.round(totalLogged * 10) / 10}</span>
                            <span class="recurring-stat-label">Minutes</span>
                        </div>
                    </div>`;
                });
            });

            html += '</div></div>';
        }

        $('reports-content').innerHTML = html;
    }

    // --- Settings ---
    // --- Theme & Accent ---
    const accentSchemes = {
        purple: { primary: '#6366F1', gradient: 'linear-gradient(135deg, #667eea, #764ba2)' },
        blue:   { primary: '#2196F3', gradient: 'linear-gradient(135deg, #2196F3, #0D47A1)' },
        green:  { primary: '#43A047', gradient: 'linear-gradient(135deg, #43A047, #1B5E20)' },
        orange: { primary: '#FF9800', gradient: 'linear-gradient(135deg, #FF9800, #E65100)' },
        red:    { primary: '#EF5350', gradient: 'linear-gradient(135deg, #EF5350, #B71C1C)' },
        teal:   { primary: '#26A69A', gradient: 'linear-gradient(135deg, #26A69A, #004D40)' },
    };

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('chores_theme', theme);
        $$('.theme-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.theme === theme);
        });
    }

    function applyAccent(accent) {
        const scheme = accentSchemes[accent];
        if (!scheme) return;
        document.documentElement.style.setProperty('--primary', scheme.primary);
        // Update gradient buttons
        const style = document.getElementById('accent-style') || document.createElement('style');
        style.id = 'accent-style';
        style.textContent = `
            .btn-primary { background: ${scheme.gradient} !important; }
            .setup-container h1, header h1 { background: ${scheme.gradient} !important; -webkit-background-clip: text !important; background-clip: text !important; }
            .btn-start, .btn-resume { background: ${scheme.gradient} !important; }
            #setup-screen { background: ${scheme.gradient} !important; }
        `;
        document.head.appendChild(style);
        localStorage.setItem('chores_accent', accent);
        $$('.accent-swatch').forEach(s => {
            s.classList.toggle('selected', s.dataset.accent === accent);
        });
    }

    function loadThemePrefs() {
        const theme = localStorage.getItem('chores_theme') || 'light';
        const accent = localStorage.getItem('chores_accent') || 'purple';
        applyTheme(theme);
        applyAccent(accent);
    }

    function initSettings() {
        $('settings-btn').addEventListener('click', () => {
            $('settings-gist-id').value = state.gistId;
            // Sync active states
            const currentTheme = localStorage.getItem('chores_theme') || 'light';
            $$('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === currentTheme));
            const currentAccent = localStorage.getItem('chores_accent') || 'purple';
            $$('.accent-swatch').forEach(s => s.classList.toggle('selected', s.dataset.accent === currentAccent));
            $('settings-modal').classList.remove('hidden');
        });

        $('close-settings-btn').addEventListener('click', () => {
            $('settings-modal').classList.add('hidden');
        });

        // Theme toggle
        $$('.theme-btn').forEach(btn => {
            btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
        });

        // Accent color
        $$('.accent-swatch').forEach(swatch => {
            swatch.addEventListener('click', () => applyAccent(swatch.dataset.accent));
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
    loadThemePrefs(); // Apply theme immediately, before DOMContentLoaded
    document.addEventListener('DOMContentLoaded', initSetup);
})();

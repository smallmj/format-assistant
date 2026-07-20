// think-detagger - SillyTavern 扩展入口
// 在每轮对话接收完整（含 MVU 变量解析、额外模型生成）后，把模型输出中思考内容里的
// "危险 tag"去掉 <>，防止酒馆助手/浏览器把未知 tag 当 HTML 解析而破坏渲染。
//
// 触发（自动与手动都只处理最近一条 AI 回复）：
//  - 自动模式（enabled）：MVU VARIABLE_UPDATE_ENDED（最精确，立即）+
//    MESSAGE_RECEIVED / GENERATION_ENDED（防抖延迟 autoDelay 秒，让 MVU 先写回）
//  - 手动：悬浮球点击 / 设置面板按钮 / 斜杠命令 /detag
// 思考内容边界标签可自定义（thinkTags，默认 think/thinking），支持标准配对与仅收尾。
// 边界标签本身保留，只对内部白名单 tag 去尖括号。

import {
    detagMes,
    detagReasoning,
    getDefaultSettings,
    DEFAULT_TAGS,
    BOUNDARY_TAGS,
    MODULE_NAME,
} from './core.js';

const SETTING_ID = 'think_detagger';
const TAG = `[${MODULE_NAME}]`;

// ---------- 通用 ----------
function getCtx() {
    return SillyTavern.getContext();
}

function getSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings[SETTING_ID]) {
        ctx.extensionSettings[SETTING_ID] = getDefaultSettings();
    }
    // 兼容老数据 / 补全新字段
    return Object.assign(getDefaultSettings(), ctx.extensionSettings[SETTING_ID]);
}

function saveSettings() {
    const ctx = getCtx();
    if (ctx.saveSettingsDebounced) ctx.saveSettingsDebounced();
}

function toast(msg, type = 'success') {
    if (typeof toastr !== 'undefined' && toastr[type]) toastr[type](msg);
    else console.log(TAG, msg);
}

// ---------- 依赖检测 ----------
function getMvu() {
    return typeof window !== 'undefined' && window.Mvu ? window.Mvu : null;
}

function waitForMvu(timeout = 10000) {
    return new Promise((resolve) => {
        if (window.Mvu) return resolve(window.Mvu);
        const start = Date.now();
        const timer = setInterval(() => {
            if (window.Mvu) {
                clearInterval(timer);
                resolve(window.Mvu);
            } else if (Date.now() - start > timeout) {
                clearInterval(timer);
                resolve(null);
            }
        }, 200);
    });
}

// ---------- 核心：处理单条消息 ----------
function processMessage(messageId) {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;
        if (messageId == null || messageId < 0) return;

        const ctx = getCtx();
        const chat = ctx.chat;
        if (!chat || !chat[messageId]) return;

        const msg = chat[messageId];
        if (msg.is_user || msg.is_system) return;

        const tags = settings.tags || DEFAULT_TAGS;
        const thinkTags = settings.thinkTags || BOUNDARY_TAGS;
        let changed = false;

        // 1. 处理 mes 里的思考区段（边界标签保留，内部去尖括号）
        if (msg.mes) {
            const r = detagMes(msg.mes, tags, thinkTags);
            if (r.changed) {
                msg.mes = r.mes;
                changed = true;
            }
        }

        // 2. 处理 extra.reasoning（原生 API 思考字段，整段去尖括号）
        if (settings.processReasoning && msg.extra && msg.extra.reasoning) {
            const r = detagReasoning(msg.extra.reasoning, tags);
            if (r.changed) {
                msg.extra.reasoning = r.reasoning;
                changed = true;
            }
        }

        if (!changed) return;

        // 3. 持久化 + 重渲
        const saveChatDebounced = ctx.saveChatDebounced || window.saveChatDebounced;
        const updateMessageBlock = ctx.updateMessageBlock || window.updateMessageBlock;
        if (saveChatDebounced) saveChatDebounced();
        if (updateMessageBlock) {
            try { updateMessageBlock(messageId, msg); }
            catch (e) { console.warn(TAG, 'updateMessageBlock 失败', e); }
        }
    } catch (e) {
        console.error(TAG, 'processMessage 异常', e);
    }
}

// ---------- 自动模式：防抖调度 ----------
let pendingTimer = null;
function scheduleProcess(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const mvu = getMvu();
    // 装了 MVU 时延迟，等 MVU（含额外模型）解析并写回；未装则立即
    const delay = mvu ? (Number(settings.autoDelay) || 0) * 1000 : 0;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => processMessage(messageId), delay);
}

function onMessageReceived(messageId) {
    scheduleProcess(messageId);
}

function onGenerationEnded() {
    // GENERATION_ENDED 只传 chat.length；额外模型生成结束也会触发，作为补充
    const chat = getCtx().chat;
    if (chat && chat.length > 0) scheduleProcess(chat.length - 1);
}

function onVarUpdateEnded(...args) {
    // MVU 事件：变量已落盘，立即处理（最精确）
    const settings = getSettings();
    if (!settings.enabled) return;
    let messageId = null;
    const a = args[0];
    if (typeof a === 'number') messageId = a;
    else if (a && typeof a === 'object') {
        messageId = a.message_id ?? a.messageId ?? a.id ?? null;
    }
    if (messageId == null) {
        const chat = getCtx().chat;
        messageId = chat ? chat.length - 1 : null;
    }
    processMessage(messageId);
}

// ---------- 手动：处理最近一条 AI 回复 ----------
function processLatestMessage() {
    try {
        const ctx = getCtx();
        const chat = ctx.chat;
        if (!chat || chat.length === 0) return false;
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (msg && !msg.is_user && !msg.is_system) {
                processMessage(i);
                const saveChatDebounced = ctx.saveChatDebounced || window.saveChatDebounced;
                if (saveChatDebounced) saveChatDebounced();
                console.log(TAG, `已处理最近一条 AI 消息 #${i}`);
                return true;
            }
        }
        return false;
    } catch (e) {
        console.error(TAG, 'processLatestMessage 异常', e);
        return false;
    }
}

// ---------- 悬浮球 ----------
function ensureFloatingBall() {
    const settings = getSettings();
    const existing = document.getElementById('td_floating_ball');
    if (!settings.showFloatingBall) {
        if (existing) existing.remove();
        return;
    }
    if (existing) return;

    const ball = document.createElement('div');
    ball.id = 'td_floating_ball';
    ball.className = 'td-floating-ball';
    ball.title = 'Think Detagger\n点击：手动去标签（最近一条 AI 回复）\n拖动：移动位置';
    ball.innerHTML = '<i class="fa-solid fa-eraser"></i>';
    document.body.appendChild(ball);

    makeDraggable(ball, () => {
        const ok = processLatestMessage();
        toast(ok ? '已处理最近一条消息' : '未找到可处理的 AI 消息');
    });
}

function makeDraggable(el, onClick) {
    let dragging = false;
    let startX = 0, startY = 0, origX = 0, origY = 0, moved = false;

    el.addEventListener('mousedown', (e) => {
        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        const rect = el.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        el.style.left = (origX + dx) + 'px';
        el.style.top = (origY + dy) + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
    el.addEventListener('click', () => {
        if (moved) { moved = false; return; }
        if (typeof onClick === 'function') onClick();
    });
}

// ---------- 设置面板 ----------
function renderSettingsPanel() {
    const container = document.getElementById('extensions_settings');
    if (!container) {
        console.warn(TAG, '未找到 #extensions_settings，设置面板未渲染');
        return;
    }
    if (document.getElementById('think_detagger_settings')) return;

    const settings = getSettings();
    const wrap = document.createElement('div');
    wrap.id = 'think_detagger_settings';
    wrap.className = 'think-detagger-settings';
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Think Detagger (思考去tag化)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input type="checkbox" id="td_enabled" ${settings.enabled ? 'checked' : ''}>
                    <span><b>自动模式</b>：每轮对话接收完整后（含额外模型解析）自动去标签</span>
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" id="td_process_reasoning" ${settings.processReasoning ? 'checked' : ''}>
                    <span>同时处理原生 reasoning (extra.reasoning)</span>
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" id="td_show_ball" ${settings.showFloatingBall ? 'checked' : ''}>
                    <span>显示悬浮球（点击手动去标签）</span>
                </label>
                <div class="td_section">
                    <label for="td_think_tags"><small>思考内容标签（边界标签，一行一个；如 think / thinking / reasoning / cot 等。这些标签本身保留，只处理其<b>内部</b>的 tag）</small></label>
                    <textarea id="td_think_tags" rows="3" class="td_textarea">${(settings.thinkTags || []).join('\n')}</textarea>
                </div>
                <div class="td_section">
                    <label for="td_tags"><small>危险 tag 白名单（一行一个；上面的思考标签勿重复加）</small></label>
                    <textarea id="td_tags" rows="8" class="td_textarea">${(settings.tags || []).join('\n')}</textarea>
                </div>
                <div class="td_section td_row">
                    <label for="td_auto_delay"><small>自动模式延迟（秒，装了 MVU 时等待变量解析；0=立即）</small></label>
                    <input type="number" id="td_auto_delay" min="0" max="60" step="1" value="${settings.autoDelay ?? 2}" class="td_number">
                </div>
                <div class="td_buttons">
                    <div class="menu_button" id="td_save_btn" title="保存设置">保存设置</div>
                    <div class="menu_button" id="td_runall_btn" title="手动处理最近一条 AI 回复">立即处理最近一条</div>
                </div>
                <small class="td_hint">自动与手动都只处理最近一条 AI 回复。手动：<code>/detag</code> 或悬浮球。</small>
            </div>
        </div>
    `;
    container.appendChild(wrap);

    const $enabled = wrap.querySelector('#td_enabled');
    const $proc = wrap.querySelector('#td_process_reasoning');
    const $ball = wrap.querySelector('#td_show_ball');
    const $thinkTags = wrap.querySelector('#td_think_tags');
    const $tags = wrap.querySelector('#td_tags');
    const $delay = wrap.querySelector('#td_auto_delay');
    const $save = wrap.querySelector('#td_save_btn');
    const $runall = wrap.querySelector('#td_runall_btn');

    const persist = () => {
        const s = getSettings();
        s.enabled = !!$enabled.checked;
        s.processReasoning = !!$proc.checked;
        s.showFloatingBall = !!$ball.checked;
        s.thinkTags = $thinkTags.value.split('\n').map(t => t.trim()).filter(Boolean);
        s.tags = $tags.value.split('\n').map(t => t.trim()).filter(Boolean);
        s.autoDelay = Number($delay.value) || 0;
        saveSettings();
        ensureFloatingBall();
    };

    $save.addEventListener('click', persist);
    $enabled.addEventListener('change', persist);
    $proc.addEventListener('change', persist);
    $ball.addEventListener('change', persist);
    $runall.addEventListener('click', () => {
        persist();
        const ok = processLatestMessage();
        toast(ok ? '已处理最近一条消息' : '未找到可处理的 AI 消息');
    });
}

// ---------- 斜杠命令 ----------
function registerSlashCommand() {
    const ctx = getCtx();
    const register = ctx.registerSlashCommand || window.registerSlashCommand;
    if (!register) {
        console.warn(TAG, '未找到 registerSlashCommand，/detag 未注册（仍可用悬浮球/按钮）');
        return;
    }
    try {
        register('detag', () => {
            const ok = processLatestMessage();
            const msg = ok ? '已处理最近一条消息' : '未找到可处理的 AI 消息';
            toast(msg);
            return msg;
        }, [], '处理最近一条 AI 回复的思考 tag', true, true);
        console.log(TAG, '已注册 /detag');
    } catch (e) {
        console.warn(TAG, '注册斜杠命令失败', e);
    }
}

// ---------- 入口 ----------
jQuery(async () => {
    const ctx = getCtx();
    if (!ctx.extensionSettings[SETTING_ID]) {
        ctx.extensionSettings[SETTING_ID] = getDefaultSettings();
    }

    renderSettingsPanel();
    registerSlashCommand();
    ensureFloatingBall();

    // 自动模式：注册事件
    try {
        ctx.eventSource.on(ctx.event_types.MESSAGE_RECEIVED, onMessageReceived);
        console.log(TAG, '已注册 MESSAGE_RECEIVED');
    } catch (e) {
        console.error(TAG, '注册 MESSAGE_RECEIVED 失败', e);
    }
    try {
        const genEvt = ctx.event_types.GENERATION_ENDED;
        if (genEvt) {
            ctx.eventSource.on(genEvt, onGenerationEnded);
            console.log(TAG, '已注册 GENERATION_ENDED');
        }
    } catch (e) {
        console.warn(TAG, '注册 GENERATION_ENDED 失败', e);
    }

    // 异步等待 MVU，注册精确事件
    waitForMvu().then((mvu) => {
        if (!mvu) {
            console.log(TAG, '未检测到 MVU，使用 MESSAGE_RECEIVED + GENERATION_ENDED 触发');
            return;
        }
        const evtName = mvu.events && mvu.events.VARIABLE_UPDATE_ENDED;
        if (!evtName) {
            console.warn(TAG, 'MVU 存在但未暴露 VARIABLE_UPDATE_ENDED 事件');
            return;
        }
        try {
            ctx.eventSource.on(evtName, onVarUpdateEnded);
            console.log(TAG, '已注册 MVU VARIABLE_UPDATE_ENDED:', evtName);
        } catch (e) {
            console.warn(TAG, '注册 MVU 事件失败', e);
        }
    });

    console.log(TAG, '已加载');
});

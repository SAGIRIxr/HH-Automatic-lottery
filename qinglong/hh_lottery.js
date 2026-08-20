/**
 * HHCLUB 幸运大转盘 · 自动化抽奖脚本（青龙 & 命令行挂机版）
 *
 * new Env('HHCLUB抽奖');
 * cron: 5 9 * * *
 *
 * 特性：
 *   - 🛑 达到设定次数或憨豆不足时自动停止，并推送最终统计通知
 *   - 🔄 可选后台持续挂机：憨豆不足自动休眠等待做种产出，回血后继续自动抽
 *   - 🎉 大奖即时推送：命中 邀请、VIP（或折算憨豆）、78w+ 憨豆等大奖即时推送
 *   - 📊 周期统计简报：每隔 1 小时（或自定义频率）推送运行简报卡片
 *   - 💾 统计实时落盘与导入导出：每抽一注立刻实时安全落盘，支持导入历史备份
 *   - 📱 推送故障转移：优先使用青龙 sendNotify，失败时再用 Telegram Bot 直连兜底
 *   - 📪 站内信清理：抽奖同时自动清理系统抽奖通知信，不误删重要邮件
 *
 * 命令行指令：
 *   - 正常运行 / 挂机： node hh_lottery.js
 *   - 导入历史备份：     node hh_lottery.js --import <backup.json>
 *
 * 依赖：Node 18+（内置 fetch，无需 npm install 任何依赖）
 * 仓库：https://github.com/Agonie0v0/HH-Automatic-lottery
 * 协议：MIT
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/* =========================================================
   ⚙️ 配置区 —— 只用改这一块，下面的都不用动
========================================================= */

const CONFIG = {
    /* ① Cookie（必填）
          浏览器登录 hhanclub.net → F12 → Network → 随便点一个请求
          → 请求头里的 Cookie 整行复制过来 */
    cookie: '在这里粘贴你的 Cookie',

    /* ② 每次运行抽多少次。
          达到该次数后自动停止并发送统计通知。
          填 0 = 一抽到底 / 持续挂机，一直抽到余额跌破下面的保留线为止 */
    draws: 10,

    /* ③ 一抽到底 / 挂机模式时给自己留多少憨豆不动 */
    reserve: 0,

    /* ④ 每抽间隔（秒）。站点有重复点击风控，别贪快，最小 3 */
    interval: 8,

    /* ⑤ 单次运行的时间上限（分钟）。
          一抽到底可能跑很久，这个是防止把任务挂死的保险；
          设为 0 表示不限制单次运行时间（后台持续挂机建议设为 0） */
    maxMinutes: 60,

    /* ⑥ 后台持续挂机抽奖模式。
          true = 余额不足时自动休眠等待做种产出，不退出，后台一直抽；
          false = 达到设定次数或余额不足即停止并发送统计通知（默认推荐） */
    continuous: false,

    /* ⑦ 持续模式下，余额不足时的休眠检查间隔（分钟）。默认 10 分钟 */
    sleepOnLowMinutes: 10,

    /* ⑧ 大奖即时通知。
          抽中 邀请、VIP、或 ≥ 78w 憨豆等大奖时立即推送通知 */
    notifyBigPrize: true,

    /* ⑨ 触发大奖推送的憨豆/数值门槛（默认 780000 即 78w） */
    bigPrizeMinBeans: 780000,

    /* ⑩ 定期统计简报推送间隔（分钟）。
          例如 60 = 每隔 1 小时推送一次时段中奖简报；
          填 0 = 不发送周期简报，仅在大奖或结束时推送 */
    reportIntervalMinutes: 60,

    /* ⑪ 抽完顺手清掉「幸运大转盘 中奖通知」站内信。
          站点每抽一次就发一封，不清的话收件箱很快被埋掉。
          只删这一种，「种子被删除」之类的一封不碰 */
    cleanMail: false,

    /* ⑫ 统计存到哪个文件。跨次运行累计，留空 '' 就是不记 */
    statsFile: 'hh_lottery_stats.json',

    /* ⑬ 要导入的历史备份 JSON 文件路径（可选，也可通过 CLI: node hh_lottery.js --import <file> 导入） */
    importFile: '',

    /* ⑭ Telegram 推送配置（可选，也可在青龙环境变量配置 TG_BOT_TOKEN 与 TG_USER_ID） */
    tgBotToken: '',
    tgUserId: '',
    tgApiHost: '',

    /* ⑮ 日志时间按哪个时区显示。
          青龙容器默认常是 UTC，不设这个的话日志时间对不上 */
    timezone: 'Asia/Shanghai',

    /* ⑯ 站点域名，一般不用改 */
    host: 'hhanclub.net',

    /* ⑰ User-Agent，一般不用改 */
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
};

/* ===== 配置区结束 ===== */

/* 下面这些是内部节奏参数，除非站点风控变了，否则不用碰 */
const RUNTIME = {
    // 请求节奏抖动比例，避免固定频率特征
    jitter: 0.15,
    // 连续失败多少次放弃
    maxErrors: 5,
    // 连续被限流多少次放弃
    maxRateLimits: 12,
    // 被限流后的退避
    backoffAfter: 3,
    backoffFactor: 1.5,
    maxBackoffMs: 30000,
    // 读不到站点公布的折算金额时用这个兜底
    vipSwapFallbackBeans: 1000000,
    // 查不到等级时才用余额差兜底判断。容差收得比较紧 ——
    // 松了的话别人赠送一笔魔力就可能被误判成折算
    vipSwapTolerance: 20000,
    // 站内信一次提交多少个 id
    mailChunk: 100,
    // 站内信翻页上限（每页显示多少封是用户自己在站点设置里定的）
    mailMaxPages: 600,
    // 反复清第一页的轮数上限
    mailSweepRounds: 20,
    // 抽奖途中每多少抽顺手清一次
    mailCleanEveryDraws: 25,
    lotteryMailKeyword: '幸运大转盘'
};

/* 青龙环境变量支持（优先级：hh_lottery.config.json > 环境变量 > 脚本默认） */
function loadEnvConfig() {
    const env = process.env;
    if (env.HH_COOKIE || env.HHCLUB_COOKIE) CONFIG.cookie = env.HH_COOKIE || env.HHCLUB_COOKIE;
    if (env.HH_DRAWS !== undefined) CONFIG.draws = env.HH_DRAWS;
    if (env.HH_RESERVE !== undefined) CONFIG.reserve = env.HH_RESERVE;
    if (env.HH_INTERVAL !== undefined) CONFIG.interval = env.HH_INTERVAL;
    if (env.HH_MAX_MINUTES !== undefined) CONFIG.maxMinutes = env.HH_MAX_MINUTES;
    if (env.HH_CONTINUOUS !== undefined) CONFIG.continuous = env.HH_CONTINUOUS === 'true' || env.HH_CONTINUOUS === '1';
    if (env.HH_SLEEP_ON_LOW !== undefined) CONFIG.sleepOnLowMinutes = env.HH_SLEEP_ON_LOW;
    if (env.HH_NOTIFY_BIG_PRIZE !== undefined) CONFIG.notifyBigPrize = env.HH_NOTIFY_BIG_PRIZE !== 'false' && env.HH_NOTIFY_BIG_PRIZE !== '0';
    if (env.HH_BIG_PRIZE_MIN !== undefined) CONFIG.bigPrizeMinBeans = env.HH_BIG_PRIZE_MIN;
    if (env.HH_REPORT_INTERVAL !== undefined) CONFIG.reportIntervalMinutes = env.HH_REPORT_INTERVAL;
    if (env.HH_CLEAN_MAIL !== undefined) CONFIG.cleanMail = env.HH_CLEAN_MAIL === 'true' || env.HH_CLEAN_MAIL === '1';
    if (env.HH_STATS_FILE !== undefined) CONFIG.statsFile = env.HH_STATS_FILE;
    if (env.HH_IMPORT_FILE !== undefined) CONFIG.importFile = env.HH_IMPORT_FILE;
    if (env.TG_BOT_TOKEN) CONFIG.tgBotToken = env.TG_BOT_TOKEN;
    if (env.TG_USER_ID) CONFIG.tgUserId = env.TG_USER_ID;
    if (env.TG_API_HOST) CONFIG.tgApiHost = env.TG_API_HOST;
    if (env.HH_TIMEZONE !== undefined) CONFIG.timezone = env.HH_TIMEZONE;
    if (env.HH_HOST !== undefined) CONFIG.host = env.HH_HOST;
}

/* 配置是手填的，收一遍边界，免得填了个负数或者字符串就跑出怪结果 */
function normalizeConfig() {
    const int = (value, fallback, min) => {
        const number = parseInt(value, 10);
        return Number.isFinite(number) ? Math.max(min, number) : fallback;
    };

    CONFIG.draws = int(CONFIG.draws, 10, 0);
    CONFIG.reserve = int(CONFIG.reserve, 0, 0);
    CONFIG.interval = int(CONFIG.interval, 8, 3);
    CONFIG.maxMinutes = int(CONFIG.maxMinutes, 60, 0);
    CONFIG.continuous = CONFIG.continuous === true || String(CONFIG.continuous).toLowerCase() === 'true' || String(CONFIG.continuous) === '1';
    CONFIG.sleepOnLowMinutes = int(CONFIG.sleepOnLowMinutes, 10, 1);
    CONFIG.notifyBigPrize = CONFIG.notifyBigPrize !== false && String(CONFIG.notifyBigPrize).toLowerCase() !== 'false' && String(CONFIG.notifyBigPrize) !== '0';
    CONFIG.bigPrizeMinBeans = int(CONFIG.bigPrizeMinBeans, 780000, 1);
    CONFIG.reportIntervalMinutes = int(CONFIG.reportIntervalMinutes, 60, 0);
    CONFIG.cleanMail = CONFIG.cleanMail === true || String(CONFIG.cleanMail).toLowerCase() === 'true' || String(CONFIG.cleanMail) === '1';
    CONFIG.host = String(CONFIG.host || 'hhanclub.net').trim().replace(/\/+$/, '');
    CONFIG.statsFile = String(CONFIG.statsFile || '').trim();
    CONFIG.importFile = String(CONFIG.importFile || '').trim();
    CONFIG.tgBotToken = String(CONFIG.tgBotToken || '').trim();
    CONFIG.tgUserId = String(CONFIG.tgUserId || '').trim();
    CONFIG.tgApiHost = String(CONFIG.tgApiHost || '').trim();
    CONFIG.timezone = String(CONFIG.timezone || '').trim();
}

/* 外置配置文件。有它就以它为准 ——
   这样 curl 覆盖脚本更新时，配置不会跟着被冲掉。 */
const CONFIG_FILE = 'hh_lottery.config.json';

function configPath() {
    return path.join(__dirname, CONFIG_FILE);
}

/* 返回实际生效的配置文件路径；没有 / 读不出来返回空字符串 */
function loadExternalConfig() {
    const file = configPath();
    if (!fs.existsSync(file)) return '';

    let data;
    try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        log(`⚠️ ${CONFIG_FILE} 不是合法 JSON（${error?.message || error}），改用脚本里的配置`);
        return '';
    }
    if (!data || typeof data !== 'object') return '';

    const unknown = [];
    Object.entries(data).forEach(([key, value]) => {
        if (key === '//') return;
        if (Object.prototype.hasOwnProperty.call(CONFIG, key)) CONFIG[key] = value;
        else unknown.push(key);
    });
    if (unknown.length) log(`⚠️ ${CONFIG_FILE} 里有认不出的项，已忽略：${unknown.join(', ')}`);

    return file;
}

function writeConfigTemplate() {
    const file = configPath();
    const template = {
        '//': '配置放这里，更新脚本时不会被覆盖。各项含义见 qinglong/README.md',
        ...CONFIG
    };

    try {
        fs.writeFileSync(file, JSON.stringify(template, null, 4));
        return file;
    } catch (error) {
        return '';
    }
}

/* 还没填 Cookie 的占位文字要认出来，不然会拿着「在这里粘贴」去请求 */
function readCookie() {
    const cookie = String(CONFIG.cookie || '').trim();
    return cookie && !cookie.includes('在这里粘贴') ? cookie : '';
}

/* =========================================================
   小工具
========================================================= */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* 日志时间。跑在容器里的话系统时区多半是 UTC，跟人对不上，
   所以按 CONFIG.timezone 显示；时区名写错就退回 ISO。 */
function stamp() {
    const now = new Date();
    try {
        return now.toLocaleString('zh-CN', {
            timeZone: CONFIG.timezone || undefined,
            hour12: false,
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    } catch (error) {
        return now.toISOString().slice(5, 19).replace('T', ' ');
    }
}

function log(line = '') {
    console.log(line === '' ? '' : `[${stamp()}] ${line}`);
}

/* 汇总那种多行块不套时间戳，套上反而没法看 */
function raw(block) {
    console.log(block);
}

const messages = [];
function report(line) {
    messages.push(line);
    log(line);
}

function fmt(value) {
    const number = Number(value) || 0;
    return number.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}小时 ${minutes}分`;
    if (minutes > 0) return `${minutes}分钟 ${seconds}秒`;
    return `${seconds}秒`;
}

/* 从文本里取第一个数字，兼容 "1,000" 这种千分位写法 */
function firstNumber(text) {
    const match = String(text ?? '').match(/(\d[\d,]*(?:\.\d+)?)/);
    return match ? parseFloat(match[1].replace(/,/g, '')) : null;
}

/* 接口返回的中奖文案是 \uXXXX 转义过的 */
function decodeUnicode(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/\\u[\dA-F]{4}/gi, match =>
        String.fromCharCode(parseInt(match.slice(2), 16))
    );
}

/* 没有 DOM，只能在 HTML 里按 class 取值 */
function textAfterClass(html, className, span = 400) {
    const matched = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`, 'i').exec(html);
    if (!matched) return null;

    const start = html.indexOf('>', matched.index);
    if (start < 0) return null;

    return html.slice(start + 1, start + 1 + span).replace(/<[^>]*>/g, ' ');
}

function numberAfterClass(html, className) {
    return firstNumber(textAfterClass(html, className));
}

/* =========================================================
   奖品解析
========================================================= */

const PRIZE_META = {
    beans: { name: '憨豆', icon: '💰', unit: '' },
    magic: { name: '憨豆（旧魔力）', icon: '💰', unit: '' },
    invite: { name: '邀请', icon: '📧', unit: '' },
    rainbow: { name: '彩虹ID', icon: '🌈', unit: '天' },
    vip: { name: 'VIP', icon: '⭐', unit: '天' },
    makeup: { name: '补签卡', icon: '🎫', unit: '个' },
    upload: { name: '上传量', icon: '⬆️', unit: 'GB' },
    rename: { name: '改名卡', icon: '📛', unit: '张' },
    unknown: { name: '其他奖品', icon: '🎁', unit: '' }
};

function parsePrizeText(text) {
    const compact = String(text || '').trim().replace(/\s+/g, ' ');
    const fallback = { type: 'unknown', value: 0, label: compact || '未知奖品' };
    if (!compact) return fallback;

    const rules = [
        { type: 'beans', test: t => t.includes('魔力') || t.includes('憨豆') },
        { type: 'invite', test: t => t.includes('邀请') },
        { type: 'rainbow', test: t => t.includes('彩虹') },
        { type: 'vip', test: t => /VIP/i.test(t) },
        { type: 'makeup', test: t => t.includes('补签') },
        { type: 'upload', test: t => t.includes('上传') },
        { type: 'rename', test: t => t.includes('改名') }
    ];

    for (const rule of rules) {
        if (!rule.test(compact)) continue;

        const meta = PRIZE_META[rule.type];
        let value;

        if (rule.type === 'upload') {
            const match = compact.match(/(\d[\d,]*(?:\.\d+)?)\s*(TB|GB|MB)/i);
            if (!match) break;
            value = parseFloat(match[1].replace(/,/g, ''));
            const unit = match[2].toUpperCase();
            if (unit === 'TB') value *= 1024;
            if (unit === 'MB') value /= 1024;
            value = Math.round(value * 100) / 100;
        } else {
            value = firstNumber(compact);
            if (value === null) break;
        }

        return {
            type: rule.type,
            value,
            label: `${fmt(value)}${meta.unit ? ' ' + meta.unit : ' ' + meta.name}`
        };
    }

    return fallback;
}

/* 判定是否为值得立即通知的大奖（邀请、VIP、78w+ 憨豆等） */
function isBigPrize(prize) {
    if (!prize || prize.type === 'unknown') return false;
    if (prize.type === 'invite') return true;
    if (prize.type === 'vip') return true;
    if (prize.type === 'beans' && prize.value >= CONFIG.bigPrizeMinBeans) return true;
    if (prize.value >= CONFIG.bigPrizeMinBeans) return true;
    return false;
}

/* 收件箱里只有主题带这几个字的会被删 */
const isLotteryMail = item => item.subject.includes(RUNTIME.lotteryMailKeyword);

function parseVipSwapBeansFrom(html) {
    const text = String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const match = text.match(/当中奖\s*\[?\s*VIP\s*\]?[^当]{0,80}?奖励憨豆[：:]\s*([\d,]+)/i);
    if (!match) return 0;

    const value = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(value) && value > 0 ? value : 0;
}

const CLASS_RANK = {
    user: 1, power: 2, elite: 3, crazy: 4, insane: 5, veteran: 6,
    extreme: 7, ultimate: 8, nexusmaster: 9, vip: 10, retiree: 11,
    uploader: 12, moderator: 13, coadministrator: 14,
    administrator: 15, sysop: 16, staffleader: 17
};

/* =========================================================
   统计与数据导入导出
========================================================= */

function emptyStats() {
    return {
        version: 4,
        draws: 0,
        cost: 0,
        gains: { beans: 0, magic: 0, invite: 0, rainbow: 0, vip: 0, makeup: 0, upload: 0, rename: 0 },
        prizes: {},
        raw: {},
        firstAt: null,
        lastAt: null
    };
}

function ensureBucket(stats, type) {
    if (!stats.prizes[type]) stats.prizes[type] = { count: 0, value: 0, tiers: {} };
    return stats.prizes[type];
}

function normalizeStats(data) {
    const stats = emptyStats();
    if (!data || typeof data !== 'object') return stats;

    stats.draws = Number(data.draws) || 0;
    stats.cost = Number(data.cost) || 0;
    stats.firstAt = data.firstAt || null;
    stats.lastAt = data.lastAt || null;

    Object.keys(stats.gains).forEach(key => {
        stats.gains[key] = Number(data.gains?.[key]) || 0;
    });
    stats.gains.beans += Number(data.gains?.magic) || 0;
    stats.gains.magic = 0;

    Object.entries(data.prizes || {}).forEach(([type, bucket]) => {
        const merged = ensureBucket(stats, type === 'magic' ? 'beans' : type);
        merged.count += Number(bucket?.count) || 0;
        merged.value += Number(bucket?.value) || 0;

        const swapped = Number(bucket?.swappedBeans) || 0;
        if (swapped) merged.swappedBeans = (merged.swappedBeans || 0) + swapped;
        Object.entries(bucket?.tiers || {}).forEach(([label, count]) => {
            merged.tiers[label] = (merged.tiers[label] || 0) + (Number(count) || 0);
        });
    });

    stats.raw = { ...(data.raw || {}) };
    return stats;
}

function mergeStats(target, source) {
    if (!source || typeof source !== 'object') return target;
    const norm = normalizeStats(source?.total || source?.current || source);

    target.draws += norm.draws;
    target.cost += norm.cost;

    Object.keys(target.gains).forEach(key => {
        target.gains[key] = (target.gains[key] || 0) + (norm.gains[key] || 0);
    });

    Object.entries(norm.prizes || {}).forEach(([type, bucket]) => {
        const targetBucket = ensureBucket(target, type);
        targetBucket.count += Number(bucket?.count) || 0;
        targetBucket.value += Number(bucket?.value) || 0;
        if (bucket?.swappedBeans) {
            targetBucket.swappedBeans = (targetBucket.swappedBeans || 0) + Number(bucket.swappedBeans);
        }
        Object.entries(bucket?.tiers || {}).forEach(([label, count]) => {
            targetBucket.tiers[label] = (targetBucket.tiers[label] || 0) + (Number(count) || 0);
        });
    });

    Object.entries(norm.raw || {}).forEach(([key, count]) => {
        target.raw[key] = (target.raw[key] || 0) + (Number(count) || 0);
    });

    if (norm.firstAt && (!target.firstAt || norm.firstAt < target.firstAt)) {
        target.firstAt = norm.firstAt;
    }
    if (norm.lastAt && (!target.lastAt || norm.lastAt > target.lastAt)) {
        target.lastAt = norm.lastAt;
    }

    return target;
}

function importStatsFile(importFilePath) {
    const absPath = path.isAbsolute(importFilePath) ? importFilePath : path.join(process.cwd(), importFilePath);
    if (!fs.existsSync(absPath)) {
        log(`❌ 导入文件不存在：${absPath}`);
        return false;
    }

    let payload;
    try {
        payload = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    } catch (err) {
        log(`❌ 导入文件不是合法的 JSON：${err?.message || err}`);
        return false;
    }

    const currentTotal = loadTotal();
    const beforeDraws = currentTotal.draws;
    mergeStats(currentTotal, payload);
    const addedDraws = currentTotal.draws - beforeDraws;

    const savedFile = saveStats(emptyStats(), currentTotal);
    log(`📥 成功导入历史记录文件：${absPath}`);
    log(`   合并了 ${fmt(addedDraws)} 抽历史数据，当前历史累计达到 ${fmt(currentTotal.draws)} 抽`);
    if (savedFile) log(`💾 已合并保存到统计文件：${savedFile}`);
    return true;
}

function applyPrize(stats, prizeText, cost, prize) {
    stats.draws += 1;
    stats.cost += cost;

    if (prize.type !== 'unknown') {
        stats.gains[prize.type] = (stats.gains[prize.type] || 0) + prize.value;
    }

    const bucket = ensureBucket(stats, prize.type);
    bucket.count += 1;
    bucket.value += prize.value;
    bucket.tiers[prize.label] = (bucket.tiers[prize.label] || 0) + 1;

    const rawKey = String(prizeText).trim();
    stats.raw[rawKey] = (stats.raw[rawKey] || 0) + 1;

    stats.lastAt = Date.now();
    if (!stats.firstAt) stats.firstAt = stats.lastAt;
}

/* 把刚记下的那一注 VIP 改标成「已转换为憨豆」。 */
function markVipSwapped(stats, prize, beans) {
    stats.gains.vip = (stats.gains.vip || 0) - prize.value;
    stats.gains.beans = (stats.gains.beans || 0) + beans;

    const bucket = ensureBucket(stats, 'vip');
    bucket.value -= prize.value;
    bucket.swappedBeans = (bucket.swappedBeans || 0) + beans;
    bucket.tiers[prize.label] = (bucket.tiers[prize.label] || 0) - 1;
    if (bucket.tiers[prize.label] <= 0) delete bucket.tiers[prize.label];

    const swappedLabel = `已转换为憨豆 ${fmt(beans)}`;
    bucket.tiers[swappedLabel] = (bucket.tiers[swappedLabel] || 0) + 1;
}

/* 所有类别里被折算成憨豆的总额。 */
function swappedBeansTotal(stats) {
    return Object.values(stats?.prizes || {})
        .reduce((sum, bucket) => sum + (Number(bucket.swappedBeans) || 0), 0);
}

function statsPath() {
    if (!CONFIG.statsFile) return '';
    return path.isAbsolute(CONFIG.statsFile)
        ? CONFIG.statsFile
        : path.join(__dirname, CONFIG.statsFile);
}

function loadTotal() {
    const file = statsPath();
    if (!file || !fs.existsSync(file)) return emptyStats();

    try {
        const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
        return normalizeStats(payload?.total || payload?.current || payload);
    } catch (error) {
        report(`⚠️ 统计文件读不出来（${error?.message || error}），这次从零开始记`);
        return emptyStats();
    }
}

/* 导出为通用备份 JSON 格式（原子写入） */
function saveStats(current, total) {
    const file = statsPath();
    if (!file) return '';

    const payload = {
        kind: 'hhclub-lottery-backup',
        version: 4,
        exportedAt: new Date().toISOString(),
        source: 'qinglong',
        current,
        total
    };

    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });

        const temp = `${file}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
        fs.renameSync(temp, file);

        return file;
    } catch (error) {
        report(`⚠️ 统计写不进去（${error?.message || error}）`);
        return '';
    }
}

/* =========================================================
   通知渲染模板（卡片式美化排版）
========================================================= */

const NOTICE_DIVIDER = `━━━━━━━━━━━━━━━━━━━`;

function statsMetrics(stats) {
    const gained = Number(stats?.gains?.beans) || 0;
    const cost = Number(stats?.cost) || 0;
    const profit = gained - cost;
    const rate = cost > 0 ? (profit / cost) * 100 : 0;
    return { gained, cost, profit, rate, swapped: swappedBeansTotal(stats || emptyStats()) };
}

function prizeValueSummary(type, bucket) {
    const value = Number(bucket?.value) || 0;
    const swapped = Number(bucket?.swappedBeans) || 0;
    const unitMap = {
        beans: '憨豆', magic: '憨豆', invite: '个', rainbow: '天',
        vip: '天', makeup: '个', upload: 'GB', rename: '张'
    };
    const parts = [];
    if (value > 0) parts.push(`${fmt(value)}${unitMap[type] ? ` ${unitMap[type]}` : ''}`);
    if (swapped > 0) parts.push(`折算 ${fmt(swapped)} 憨豆`);
    return parts.join(' · ');
}

function renderPrizeDetails(stats, emptyText = '暂无奖品记录') {
    const rows = Object.entries(stats?.prizes || {})
        .filter(([, bucket]) => Number(bucket?.count) > 0)
        .sort((a, b) => b[1].count - a[1].count)
        .flatMap(([type, bucket]) => {
            const meta = PRIZE_META[type] || PRIZE_META.unknown;
            const value = prizeValueSummary(type, bucket);
            const head = `  ${meta.icon} ${meta.name}｜${fmt(bucket.count)} 次${value ? ` · ${value}` : ''}`;
            const tiers = Object.entries(bucket.tiers || {})
                .filter(([, count]) => Number(count) > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([label, count]) => `     └ ${label} × ${fmt(count)}`);
            return [head, ...tiers];
        });
    return rows.length ? rows : [`  • ${emptyText}`];
}

function renderStatsOverview(stats, { delta = false } = {}) {
    const { gained, cost, profit, rate, swapped } = statsMetrics(stats);
    const plus = delta ? '+' : '';
    const minus = delta ? '-' : '';
    return [
        `  🎰 抽奖：${plus}${fmt(stats?.draws)} 抽`,
        `  💸 消耗：${minus}${fmt(cost)} 憨豆`,
        `  🎁 获得：${plus}${fmt(gained)} 憨豆${swapped > 0 ? `（含折算 ${fmt(swapped)}）` : ''}`,
        `  ${profit >= 0 ? '🚀' : '✨'} 净盈亏：${profit >= 0 ? '+' : ''}${fmt(profit)}（${profit >= 0 ? '+' : ''}${rate.toFixed(1)}%）`
    ];
}

function renderBigPrizeNotification({ prize, prizeText, drawIndex, totalDraws, balance, stats, vipSwappedBeans = 0 }) {
    const meta = PRIZE_META[prize.type] || PRIZE_META.unknown;
    let prizeDisplay = '';
    if (prize.type === 'vip') {
        if (vipSwappedBeans > 0) {
            prizeDisplay = `⭐ VIP（已自动折算 ${fmt(vipSwappedBeans)} 憨豆）`;
        } else {
            prizeDisplay = `⭐ VIP ${fmt(prize.value)} 天`;
        }
    } else if (prize.type === 'invite') {
        prizeDisplay = `📧 邀请码 ${fmt(prize.value)} 个`;
    } else if (prize.type === 'beans') {
        prizeDisplay = `💰 ${fmt(prize.value)} 憨豆`;
    } else {
        prizeDisplay = `${meta.icon} ${prize.label || prizeText.trim()}`;
    }

    const { gained, profit, rate } = statsMetrics(stats);

    return [
        `╭─ 🎊 欧皇降临`,
        `│ 命中大奖：${prizeDisplay}`,
        `│ 中奖时间：${stamp()}`,
        `│ 当前抽数：本次第 ${fmt(drawIndex)} 抽`,
        `╰─ 历史累计：${fmt(totalDraws)} 抽`,
        NOTICE_DIVIDER,
        `📊 本次运行数据`,
        `  🎰 已抽：${fmt(stats.draws)} 抽`,
        `  💸 消耗：${fmt(stats.cost)} 憨豆`,
        `  🎁 获得：${fmt(gained)} 憨豆${vipSwappedBeans > 0 ? `（含 VIP 折算）` : ''}`,
        `  ${profit >= 0 ? '🚀' : '✨'} 净盈亏：${profit >= 0 ? '+' : ''}${fmt(profit)}（${profit >= 0 ? '+' : ''}${rate.toFixed(1)}%）`,
        `  💵 当前余额：${fmt(balance)} 憨豆`,
        NOTICE_DIVIDER,
        `🤖 ${CONFIG.continuous ? '后台持续挂机抽奖中' : '抽奖任务运行中'}`
    ].join('\n');
}

function renderPeriodReport({ period, total, balance, periodMinutes, totalTimeStr }) {
    return [
        `╭─ ⏱️ 播报概览`,
        `│ 统计区间：近 ${periodMinutes} 分钟`,
        `│ 持续运行：${totalTimeStr}`,
        `╰─ 播报时间：${stamp()}`,
        NOTICE_DIVIDER,
        `🆕 此次播报增量`,
        ...renderStatsOverview(period, { delta: true }),
        `  💵 当前余额：${fmt(balance)} 憨豆`,
        NOTICE_DIVIDER,
        `🎁 此次奖品明细`,
        ...renderPrizeDetails(period, '本时段无抽奖记录（休眠 / 待机中）'),
        NOTICE_DIVIDER,
        `🏆 历史累计总量（含此次增量）`,
        ...renderStatsOverview(total),
        NOTICE_DIVIDER,
        `🗂️ 历史奖品明细`,
        ...renderPrizeDetails(total, '暂无历史奖品记录'),
        NOTICE_DIVIDER,
        `🤖 ${CONFIG.continuous ? '后台持续监控与抽奖中' : '抽奖任务运行中'} · 下次播报约 ${CONFIG.reportIntervalMinutes} 分钟后`
    ].join('\n');
}

function renderFinalReport({ current, total, balance, runningTimeStr, status = '正常结束' }) {
    const lines = [
        `╭─ 🎯 任务结算`,
        `│ 运行状态：${status}`,
        `│ 运行时长：${runningTimeStr}`,
        `│ 最终余额：${fmt(balance)} 憨豆`,
        `╰─ 结束时间：${stamp()}`,
        NOTICE_DIVIDER,
        `🆕 本次运行增量`,
        ...renderStatsOverview(current, { delta: true }),
        NOTICE_DIVIDER,
        `🎁 本次奖品明细`,
        ...renderPrizeDetails(current, '本次无奖品记录'),
        NOTICE_DIVIDER,
        `🏆 历史累计总览（含本次）`,
        ...renderStatsOverview(total),
        NOTICE_DIVIDER,
        `🗂️ 历史奖品明细`,
        ...renderPrizeDetails(total, '暂无历史奖品记录')
    ];
    return lines.join('\n');
}

/* =========================================================
   抽奖核心类
========================================================= */

class Lottery {
    constructor(cookie) {
        this.cookie = cookie;
        this.origin = /^https?:\/\//.test(CONFIG.host) ? CONFIG.host : `https://${CONFIG.host}`;

        this.balance = 0;
        this.cost = 2000;
        this.stopReason = '';
        this.interrupted = false;

        this.startedAt = Date.now();
        this.current = emptyStats();
        this.total = loadTotal();

        // 周期统计数据
        this.period = emptyStats();
        this.periodStartTime = Date.now();
        this.lastReportTime = Date.now();

        this.vipSwapBeans = 0;
        this.vipOrAbove = null;
        this.vipClassChecked = false;

        this.mailCleaned = 0;

        this.errorStreak = 0;
        this.rateLimitStreak = 0;
        this.intervalMs = CONFIG.interval * 1000;
        this.deadline = CONFIG.maxMinutes > 0 ? Date.now() + CONFIG.maxMinutes * 60 * 1000 : 0;
        this.isContinuous = CONFIG.continuous;
    }

    headers(extra = {}) {
        return {
            'cookie': this.cookie,
            'user-agent': CONFIG.userAgent,
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'referer': `${this.origin}/lucky.php`,
            ...extra
        };
    }

    async get(urlPath) {
        const response = await fetch(`${this.origin}${urlPath}`, { headers: this.headers() });
        if (!response.ok) throw new Error(`${urlPath} 请求失败（HTTP ${response.status}）`);
        return response.text();
    }

    async snapshot() {
        const html = await this.get('/lucky.php');

        if (/takelogin\.php|name="password"/i.test(html)) {
            throw new Error('Cookie 已失效，站点把我踢回登录页了');
        }

        const swapBeans = parseVipSwapBeansFrom(html);
        if (swapBeans > 0) this.vipSwapBeans = swapBeans;

        const balance = numberAfterClass(html, 'bean-number');
        const cost = numberAfterClass(html, 'use-bean');

        if (balance === null) throw new Error('读不到憨豆余额，站点可能改版了');

        return { balance, cost: cost && cost > 0 ? Math.round(cost) : null };
    }

    async drawOnce() {
        const response = await fetch(`${this.origin}/plugin/lucky-draw`, {
            method: 'POST',
            headers: this.headers({
                'x-requested-with': 'XMLHttpRequest',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
            }),
            body: ''
        });

        const text = await response.text();
        try {
            return { ok: response.ok, status: response.status, data: JSON.parse(text) };
        } catch (error) {
            return { ok: false, status: response.status, data: null, raw: text };
        }
    }

    record(prizeText, prize) {
        applyPrize(this.current, prizeText, this.cost, prize);
        applyPrize(this.total, prizeText, this.cost, prize);
        if (this.period) applyPrize(this.period, prizeText, this.cost, prize);
    }

    readVipSwapBeans() {
        return this.vipSwapBeans || RUNTIME.vipSwapFallbackBeans;
    }

    async fetchSelfUserId() {
        const match = (await this.get('/usercp.php')).match(/userdetails\.php\?id=(\d+)/);
        return match ? match[1] : null;
    }

    async checkVipOrAbove() {
        if (this.vipClassChecked) return this.vipOrAbove;

        try {
            const id = await this.fetchSelfUserId();
            if (!id) return null;

            const html = await this.get(`/userdetails.php?id=${id}`);
            const match = html.match(/等级[：:][\s\S]{0,300}?pic\/(\w+)\.(?:gif|png|svg|webp)/i);
            if (!match) return null;

            const rank = CLASS_RANK[match[1].toLowerCase()];
            if (!rank) return null;

            this.vipOrAbove = rank >= CLASS_RANK.vip;
            this.vipClassChecked = true;
            return this.vipOrAbove;
        } catch (error) {
            return null;
        }
    }

    async reconcileVip(prize) {
        const estimated = this.balance;

        let actual;
        try {
            actual = (await this.snapshot()).balance;
        } catch (error) {
            report('⚠️ 中了 VIP 但余额没核成 —— 你若本来就是 VIP，这一注的憨豆没记上');
            return 0;
        }

        const drift = actual - estimated;
        this.balance = actual;

        const beans = this.readVipSwapBeans();
        const eligible = await this.checkVipOrAbove();

        if (eligible === false) return 0;
        if (eligible === null) {
            if (Math.abs(drift - beans) > RUNTIME.vipSwapTolerance) {
                if (drift > RUNTIME.vipSwapTolerance) {
                    report(`⚠️ 中了 VIP 且余额变动 ${drift > 0 ? '+' : ''}${fmt(Math.round(drift))}，`
                        + '但读不到你的等级，无法确认是否折算 —— 这一注按 VIP 记');
                }
                return 0;
            }
        }

        markVipSwapped(this.current, prize, beans);
        markVipSwapped(this.total, prize, beans);
        if (this.period) markVipSwapped(this.period, prize, beans);

        report(`👑 你已经是 VIP，站点改发了 ${fmt(beans)} 憨豆 · 仍计为一次 VIP 中奖`);

        const extra = Math.round(drift - beans);
        if (Math.abs(extra) >= 1) {
            report(`ℹ️ 同期余额另有 ${extra > 0 ? '+' : ''}${fmt(extra)}（做种收益 / 赠送等），未计入中奖`);
        }
        return beans;
    }

    nextDelay() {
        const jitter = 1 + (Math.random() * 2 - 1) * RUNTIME.jitter;
        return Math.max(1000, Math.round(this.intervalMs * jitter));
    }

    shouldContinue() {
        if (this.interrupted) return false;

        if (this.deadline > 0 && Date.now() > this.deadline) {
            this.stopReason = `到达单次运行时间上限（${CONFIG.maxMinutes} 分钟）`;
            report(`⏰ ${this.stopReason}，收工`);
            return false;
        }

        // 只要设定了 draws > 0，达到设定次数就必须停止（无论是否设置了 continuous）
        if (CONFIG.draws > 0 && this.current.draws >= CONFIG.draws) {
            this.stopReason = `已达到设定抽奖次数（${fmt(CONFIG.draws)} 抽）`;
            return false;
        }

        if (this.isContinuous) {
            return true;
        }

        if (this.balance < this.cost) {
            this.stopReason = `憨豆不足（当前余额 ${fmt(this.balance)} · 单抽需 ${fmt(this.cost)}）`;
            return false;
        }

        if (this.balance - this.cost < CONFIG.reserve) {
            this.stopReason = `一抽到底完成，余额 ${fmt(this.balance)}（保留线 ${fmt(CONFIG.reserve)}）`;
            report(`🏁 ${this.stopReason}`);
            return false;
        }
        return true;
    }

    async checkPeriodicReport() {
        if (CONFIG.reportIntervalMinutes <= 0) return;
        const intervalMs = CONFIG.reportIntervalMinutes * 60 * 1000;
        const now = Date.now();
        if (now - this.lastReportTime < intervalMs) return;

        const durationMinutes = Math.max(1, Math.round((now - this.periodStartTime) / 60000));
        const totalTimeStr = formatDuration(now - this.startedAt);

        const content = renderPeriodReport({
            period: this.period,
            total: this.total,
            balance: this.balance,
            periodMinutes: durationMinutes,
            totalTimeStr
        });

        await notify('📊 HHCLUB 幸运大转盘｜定时战报', content);

        this.period = emptyStats();
        this.periodStartTime = Date.now();
        this.lastReportTime = Date.now();

        if (this.current.draws > 0) {
            saveStats(this.current, this.total);
        }
    }

    async run() {
        const start = await this.snapshot();
        this.balance = start.balance;
        if (start.cost) this.cost = start.cost;

        report(`▶ 开始 · 余额 ${fmt(this.balance)} 憨豆 · 单抽 ${fmt(this.cost)}`);

        if (this.balance < this.cost) {
            this.stopReason = `憨豆不足（当前余额 ${fmt(this.balance)} · 单抽需 ${fmt(this.cost)}）`;
            report(`💸 ${this.stopReason}，停止`);
            return;
        }

        if (CONFIG.draws === 0 && !this.isContinuous && this.balance - this.cost < CONFIG.reserve) {
            this.stopReason = `余额已在保留线之下（当前余额 ${fmt(this.balance)} · 保留线 ${fmt(CONFIG.reserve)}）`;
            report(`🏁 ${this.stopReason}，停止`);
            return;
        }

        let firstRound = true;

        while (this.shouldContinue()) {
            const needsWait = this.balance < this.cost || (CONFIG.reserve > 0 && this.balance - this.cost < CONFIG.reserve);

            if (needsWait) {
                if (!this.isContinuous) {
                    if (this.balance < this.cost) {
                        this.stopReason = `憨豆不足（当前余额 ${fmt(this.balance)} · 单抽需 ${fmt(this.cost)}）`;
                        report(`💸 ${this.stopReason}，停止`);
                    } else {
                        this.stopReason = `余额已达保留线（当前余额 ${fmt(this.balance)} · 保留线 ${fmt(CONFIG.reserve)}）`;
                        report(`🏁 ${this.stopReason}，停止`);
                    }
                    break;
                }

                log(`💸 余额不足（当前余额 ${fmt(this.balance)} · 单抽 ${fmt(this.cost)} · 保留线 ${fmt(CONFIG.reserve)}）`);
                log(`⏳ 挂起休眠 ${CONFIG.sleepOnLowMinutes} 分钟，等待做种收益积累后继续...`);

                const sleepEnd = Date.now() + CONFIG.sleepOnLowMinutes * 60 * 1000;
                while (Date.now() < sleepEnd) {
                    await sleep(Math.min(5000, sleepEnd - Date.now()));
                    await this.checkPeriodicReport();
                }

                try {
                    const fresh = await this.snapshot();
                    this.balance = fresh.balance;
                    if (fresh.cost) this.cost = fresh.cost;
                    log(`🔄 重新检测余额：当前 ${fmt(this.balance)} 憨豆`);
                } catch (error) {
                    log(`⚠️ 重新检测余额失败：${error?.message || error}`);
                }
                continue;
            }

            if (!firstRound) await sleep(this.nextDelay());
            firstRound = false;

            await this.checkPeriodicReport();

            const result = await this.drawOnce();

            if (!result.data) {
                this.errorStreak++;
                log(`❌ 请求失败（HTTP ${result.status}）`);
                if (this.errorStreak >= RUNTIME.maxErrors) {
                    this.stopReason = `连续 ${this.errorStreak} 次请求失败`;
                    report(`🛑 ${this.stopReason}，停止`);
                    return;
                }
                continue;
            }

            if (result.data.ret === 0) {
                this.errorStreak = 0;
                this.rateLimitStreak = 0;
                this.intervalMs = CONFIG.interval * 1000;

                const prizeText = decodeUnicode(result.data.data?.prize_text || '未知奖品');
                const prize = parsePrizeText(prizeText);

                this.record(prizeText, prize);
                this.balance = Math.max(0, this.balance - this.cost + (prize.type === 'beans' ? prize.value : 0));

                log(`🎲 第 ${this.current.draws} 抽：${prizeText.trim()} · 余额 ${fmt(this.balance)}`);

                let vipSwapped = 0;
                if (prize.type === 'vip') {
                    vipSwapped = await this.reconcileVip(prize);
                }

                // ⚡ 关键保障：每抽完一注立刻落盘，保证任何时刻中断数据不丢
                if (CONFIG.statsFile) {
                    saveStats(this.current, this.total);
                }

                if (CONFIG.notifyBigPrize && isBigPrize(prize)) {
                    const bigPrizeNotice = renderBigPrizeNotification({
                        prize,
                        prizeText,
                        drawIndex: this.current.draws,
                        totalDraws: this.total.draws,
                        balance: this.balance,
                        stats: this.current,
                        vipSwappedBeans: vipSwapped
                    });
                    log(`🎉 命中大奖【${prize.label || prizeText.trim()}】，立即发送即时推送通知！`);
                    await notify('🎉 HHCLUB 幸运大转盘｜命中大奖', bigPrizeNotice);
                }

                if (CONFIG.cleanMail && this.current.draws % RUNTIME.mailCleanEveryDraws === 0) {
                    await this.sweepDuringRun();
                }

                await this.checkPeriodicReport();

                // 只要达到了设定次数，立即退出
                if (CONFIG.draws > 0 && this.current.draws >= CONFIG.draws) {
                    this.stopReason = `已达到设定抽奖次数（${fmt(CONFIG.draws)} 抽）`;
                    report(`🏁 ${this.stopReason}`);
                    break;
                }
                continue;
            }

            const msg = decodeUnicode(result.data.msg || '未知错误');

            if (msg.includes('重复点击') || msg.includes('请稍后') || msg.includes('频繁')) {
                this.rateLimitStreak++;
                log(`⏳ ${msg}`);

                if (this.rateLimitStreak >= RUNTIME.backoffAfter) {
                    this.intervalMs = Math.min(this.intervalMs * RUNTIME.backoffFactor, RUNTIME.maxBackoffMs);
                    log(`🔄 间隔上调到 ${(this.intervalMs / 1000).toFixed(1)} 秒`);
                }
                if (this.rateLimitStreak >= RUNTIME.maxRateLimits) {
                    this.stopReason = `连续 ${this.rateLimitStreak} 次被限流`;
                    report(`🛑 ${this.stopReason}，停止`);
                    return;
                }
                continue;
            }

            if (msg.includes('次数') || msg.includes('用完') || msg.includes('不足')) {
                if (this.isContinuous && msg.includes('不足')) {
                    this.balance = 0;
                    continue;
                }
                this.stopReason = msg;
                report(`🛑 ${msg}，停止`);
                return;
            }

            this.errorStreak++;
            log(`❌ ${msg}`);
            if (this.errorStreak >= RUNTIME.maxErrors) {
                this.stopReason = `连续 ${this.errorStreak} 次失败：${msg}`;
                report(`🛑 ${this.stopReason}，停止`);
                return;
            }
        }
    }

    /* ---------------- 站内信清理 ---------------- */

    parseMailbox(html) {
        const items = [];
        const re = /viewmessage&(?:amp;)?id=(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = re.exec(html)) !== null) {
            items.push({ id: match[1], subject: match[2].replace(/<[^>]*>/g, '').trim() });
        }

        const select = /<select[^>]*switchPage[^>]*>([\s\S]*?)<\/select>/i.exec(html);
        const pageCount = select ? (select[1].match(/<option/gi) || []).length : 0;

        return { items, pageCount };
    }

    async mailPage(page) {
        return this.parseMailbox(await this.get(`/messages.php?action=viewmailbox&box=1&page=${page}`));
    }

    async deleteMail(ids) {
        let done = 0;

        for (let at = 0; at < ids.length; at += RUNTIME.mailChunk) {
            const chunk = ids.slice(at, at + RUNTIME.mailChunk);
            const body = new URLSearchParams();
            body.append('action', 'moveordel');
            chunk.forEach(id => body.append('messages[]', id));
            body.append('delete', '删除');

            const response = await fetch(`${this.origin}/messages.php`, {
                method: 'POST',
                headers: this.headers({ 'content-type': 'application/x-www-form-urlencoded' }),
                body
            });
            if (!response.ok) throw new Error(`删除站内信失败（HTTP ${response.status}）`);

            done += chunk.length;
        }

        return done;
    }

    async sweepFirstPage() {
        let removed = 0;

        for (let round = 0; round < RUNTIME.mailSweepRounds; round++) {
            const { items } = await this.mailPage(0);
            const ids = items.filter(isLotteryMail).map(item => item.id);
            if (!ids.length) break;
            removed += await this.deleteMail(ids);
        }

        return removed;
    }

    async sweepDuringRun() {
        try {
            const removed = await this.sweepFirstPage();
            if (!removed) return;

            this.mailCleaned += removed;
            log(`📪 清掉 ${fmt(removed)} 封抽奖通知 · 本次累计 ${fmt(this.mailCleaned)} 封`);
        } catch (error) {
            log(`⚠️ 站内信清理失败：${error?.message || error}`);
        }
    }

    async cleanMailbox() {
        let removed = 0;

        try {
            const doomed = [];
            const seen = new Set();
            const first = await this.mailPage(0);
            const totalPages = first.pageCount > 0 ? first.pageCount : RUNTIME.mailMaxPages;

            for (let page = 0; page < Math.min(totalPages, RUNTIME.mailMaxPages); page++) {
                const { items } = page === 0 ? first : await this.mailPage(page);
                if (!items.length) break;
                if (items.every(item => seen.has(item.id))) break;

                items.forEach(item => {
                    if (seen.has(item.id)) return;
                    seen.add(item.id);
                    if (isLotteryMail(item)) doomed.push(item.id);
                });

                if (first.pageCount <= 0 && items.length < first.items.length) break;
            }

            if (doomed.length) removed += await this.deleteMail(doomed);
            removed += await this.sweepFirstPage();
        } catch (error) {
            report(`⚠️ 站内信清理失败：${error?.message || error}`);
            return;
        }

        this.mailCleaned += removed;
        if (this.mailCleaned) report(`📪 本次共清掉 ${fmt(this.mailCleaned)} 封抽奖通知`);
    }

    /* ---------------- 汇总 ---------------- */

    summarize(stats, title) {
        if (!stats.draws) return `${title}：一抽未成`;

        const beans = stats.gains.beans || 0;
        const profit = beans - stats.cost;
        const rate = stats.cost > 0 ? (profit / stats.cost) * 100 : 0;

        const detail = Object.entries(stats.prizes)
            .filter(([, bucket]) => bucket.count > 0)
            .sort((a, b) => b[1].count - a[1].count)
            .flatMap(([type, bucket]) => {
                const meta = PRIZE_META[type] || PRIZE_META.unknown;

                const sums = [];
                if (bucket.value > 0) {
                    sums.push(`${fmt(bucket.value)}${meta.unit ? ' ' + meta.unit : ''}`);
                }
                if (bucket.swappedBeans > 0) {
                    sums.push(`另折算 ${fmt(bucket.swappedBeans)} 憨豆`);
                }

                const head = `  ${meta.icon} ${meta.name} ${fmt(bucket.count)} 次`
                    + (sums.length ? ` · ${sums.join(' · ')}` : '');

                const tiers = Object.entries(bucket.tiers)
                    .sort((a, b) => b[1] - a[1])
                    .map(([label, count]) => `      ${label} × ${count}`);

                return [head, ...tiers];
            });

        const swapped = swappedBeansTotal(stats);
        const beansLine = `  消耗 ${fmt(stats.cost)} · 获得 ${fmt(beans)} 憨豆`
            + (swapped > 0 ? `（其中 ${fmt(swapped)} 来自 VIP 折算）` : '');

        return [
            `${title}：${fmt(stats.draws)} 抽`,
            beansLine,
            `  盈亏 ${profit >= 0 ? '+' : ''}${fmt(profit)}（${rate >= 0 ? '+' : ''}${rate.toFixed(1)}%）`,
            ...detail
        ].join('\n');
    }

    summary() {
        const lines = [this.summarize(this.current, '本次')];
        if (CONFIG.statsFile && this.total.draws > this.current.draws) {
            lines.push('', this.summarize(this.total, '历史总计'));
        }
        lines.push('', `余额 ${fmt(this.balance)}`);
        return lines.join('\n');
    }
}

/* =========================================================
   入口与通知
========================================================= */

/* 原生直连 Telegram Bot 推送（强保障，独立可靠） */
async function sendTelegramDirect(title, content) {
    const token = CONFIG.tgBotToken || process.env.TG_BOT_TOKEN;
    const chatId = CONFIG.tgUserId || process.env.TG_USER_ID;
    if (!token || !chatId) return false;

    const host = (CONFIG.tgApiHost || process.env.TG_API_HOST || 'api.telegram.org')
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '');
    const url = `https://${host}/bot${token}/sendMessage`;
    const text = `${title}\n\n${content}`;

    log(`🚀 [Telegram 直连] 正在向 https://${host}/bot${token.slice(0, 6)}... 推送 (chat_id: ${chatId})...`);

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                disable_web_page_preview: true
            }),
            signal: controller.signal
        });
        clearTimeout(timer);

        const textResp = await response.text();
        let data;
        try { data = JSON.parse(textResp); } catch (e) { data = { raw: textResp }; }

        if (response.ok && data.ok) {
            log(`✅ [Telegram 直连] 消息已成功送达 Telegram！`);
            return true;
        } else {
            log(`❌ [Telegram 直连] Telegram 接口返回错误 (HTTP ${response.status})：${textResp}`);
            return false;
        }
    } catch (error) {
        log(`❌ [Telegram 直连] 推送失败（若为国内服务器请配置 TG_API_HOST 反代）：${error?.message || error}`);
        return false;
    }
}

async function notify(title, content, { preferTelegram = false } = {}) {
    let sentCount = 0;
    let telegramAttempted = false;

    // 青龙内置 notify.js 默认会请求「一言」并在正文末尾追加随机标语。
    // 这里仅在加载 / 调用通知模块时临时关闭，不修改用户的全局环境变量。
    const hadHitokoto = Object.prototype.hasOwnProperty.call(process.env, 'HITOKOTO');
    const originalHitokoto = process.env.HITOKOTO;
    process.env.HITOKOTO = 'false';

    try {
        // 手动停止时优先直连 Telegram：路径更短，避免青龙终止任务时
        // sendNotify 加载多通道或外部文案请求拖延送达。直连失败仍会回落 sendNotify。
        if (preferTelegram && (CONFIG.tgBotToken || process.env.TG_BOT_TOKEN)) {
            telegramAttempted = true;
            const tgOk = await sendTelegramDirect(title, content);
            if (tgOk) sentCount++;
        }

        // 1. 尝试使用青龙通用 sendNotify.js 模块
        let sender = null;
        let foundPath = '';
        const candidatePaths = [
            path.join(__dirname, 'sendNotify.js'),
            path.join(__dirname, 'sendNotify'),
            path.join(__dirname, '../sendNotify.js'),
            path.join(__dirname, '../sendNotify'),
            path.join(__dirname, '../../sendNotify.js'),
            path.join(process.cwd(), 'sendNotify.js'),
            path.join(process.cwd(), 'sendNotify'),
            path.join(process.cwd(), 'scripts/sendNotify.js'),
            './sendNotify',
            '../sendNotify',
            '/ql/data/scripts/sendNotify.js',
            '/ql/data/scripts/sendNotify',
            '/ql/scripts/sendNotify.js',
            '/ql/scripts/sendNotify',
            '/ql/shell/sendNotify.js',
            '/ql/shell/sendNotify'
        ];

        if (sentCount === 0) {
            for (const modulePath of candidatePaths) {
                try {
                    sender = require(modulePath);
                    if (sender) {
                        foundPath = modulePath;
                        break;
                    }
                } catch (error) {
                    // 继续尝试下一个候选路径
                }
            }
        }

        if (sender) {
            const send = sender.sendNotify || sender;
            if (typeof send === 'function') {
                try {
                    log(`📤 正在调用青龙通知模块（${foundPath}）发送推送...`);
                    await send(title, content);
                    sentCount++;
                } catch (error) {
                    log(`⚠️ sendNotify 推送失败：${error?.message || error}`);
                }
            }
        }

        // 2. sendNotify 未成功时才走 Telegram 直连兜底。
        //    青龙 sendNotify 通常已经集成 Telegram，两边同时发会造成重复通知。
        if (sentCount === 0 && !telegramAttempted && (CONFIG.tgBotToken || process.env.TG_BOT_TOKEN)) {
            telegramAttempted = true;
            const tgOk = await sendTelegramDirect(title, content);
            if (tgOk) sentCount++;
        } else if (sentCount === 0 && !telegramAttempted) {
            log('ℹ️ 未检测到 TG_BOT_TOKEN 环境变量。如需 TG 推送，请在青龙「环境变量」添加 TG_BOT_TOKEN 与 TG_USER_ID');
        }

        if (sentCount === 0) {
            log('ℹ️ 未能成功触发任何通知渠道');
        }
        return sentCount > 0;
    } finally {
        if (hadHitokoto) process.env.HITOKOTO = originalHitokoto;
        else delete process.env.HITOKOTO;
    }
}

/* 监听退出信号，保存已抽数据并发送停止通知 */
function guardExit(lottery) {
    let stoppingPromise = null;

    const handleExit = signal => {
        if (stoppingPromise) return stoppingPromise;

        stoppingPromise = (async () => {
            lottery.interrupted = true;
            lottery.stopReason = `收到 ${signal} 停止信号（手动停止）`;
            log(`\n⚠️ ${lottery.stopReason}，保存数据并发送通知...`);
            if (lottery.current.draws > 0 && CONFIG.statsFile) {
                const file = saveStats(lottery.current, lottery.total);
                if (file) log(`💾 统计已安全存到 ${file}`);
            }
            raw(`\n${'─'.repeat(40)}\n${lottery.summary()}`);

            const runningTime = formatDuration(Date.now() - lottery.startedAt);
            const finalReport = renderFinalReport({
                current: lottery.current,
                total: lottery.total,
                balance: lottery.balance,
                runningTimeStr: runningTime,
                status: lottery.stopReason
            });

            // 在当前主进程内完成通知推送（设置 8 秒超时保护）
            const watchdog = setTimeout(() => {
                log('⚠️ 停止通知等待超时，已保存数据并退出');
                process.exit(0);
            }, 8000);

            try {
                const sent = await notify('🛑 HHCLUB 幸运大转盘｜手动停止', finalReport, { preferTelegram: true });
                log(sent ? '✅ 手动停止通知已发送' : '⚠️ 手动停止通知未能送达');
            } catch (error) {
                log(`⚠️ 手动停止通知发送异常：${error?.message || error}`);
            } finally {
                clearTimeout(watchdog);
            }

            process.exit(0);
        })();

        return stoppingPromise;
    };

    // 青龙会通过 NODE_OPTIONS 预加载 sitecustomize.js / client.js，并比业务脚本
    // 更早注册 SIGTERM 监听器，其内部直接 process.exit(15)。EventEmitter 按
    // 注册顺序调用，若不接管，这个立即退出会让下面的异步保存 / 推送永远没机会执行。
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const inheritedListeners = signals.reduce((sum, signal) => sum + process.listenerCount(signal), 0);
    signals.forEach(signal => process.removeAllListeners(signal));

    // 必须持续监听，不能用 once：青龙的 timeout / task.sh 可能连续转发多个同类信号。
    process.on('SIGINT', () => { handleExit('SIGINT'); });
    process.on('SIGTERM', () => { handleExit('SIGTERM'); });
    process.on('SIGHUP', () => { handleExit('SIGHUP'); });
    if (inheritedListeners > 0) {
        log(`🛡️ 已接管青龙退出信号（替换 ${inheritedListeners} 个预加载立即退出处理器）`);
    }
    return handleExit;
}

async function main() {
    if (typeof fetch !== 'function') {
        log('❌ 需要 Node 18 或更高版本（脚本用的是内置 fetch）');
        process.exit(1);
    }

    const args = process.argv.slice(2);
    const importIdx = args.findIndex(arg => arg === '--import' || arg === '-i' || arg === 'import');
    if (importIdx >= 0 && args[importIdx + 1]) {
        const targetFile = args[importIdx + 1];
        const ok = importStatsFile(targetFile);
        process.exit(ok ? 0 : 1);
    }

    loadEnvConfig();
    const configFile = loadExternalConfig();
    normalizeConfig();

    if (CONFIG.importFile) {
        importStatsFile(CONFIG.importFile);
    }

    const cookie = readCookie();
    if (!cookie) {
        if (!configFile) {
            const created = writeConfigTemplate();
            if (created) {
                log(`📝 已生成配置文件 ${created}`);
                log('   把里面的 cookie 换成你的，再跑一次就行 —— 以后更新脚本不会覆盖它');
            }
        }
        log('❌ 还没填 Cookie：');
        log('   浏览器登录 hhanclub.net → F12 → Network → 任意请求 → 请求头里的 Cookie 整行复制');
        log(configFile
            ? `   填到 ${configFile} 的 cookie 里`
            : '   填到脚本最上面「配置区」的 cookie 里，或设置环境变量 HH_COOKIE');
        process.exit(1);
    }

    log('🎡 HHCLUB 幸运大转盘');
    if (configFile) log(`⚙️ 配置来自 ${configFile}`);
    if (CONFIG.draws > 0) {
        log(`🎯 运行模式：定量抽取 ${CONFIG.draws} 次（抽满自动停止并发送通知）· 间隔 ${CONFIG.interval} 秒`);
    } else if (CONFIG.continuous) {
        log(`🔄 运行模式：后台持续挂机（无憨豆时休眠 ${CONFIG.sleepOnLowMinutes} 分钟 · 保留 ${fmt(CONFIG.reserve)} 憨豆）`);
    } else {
        log(`   一抽到底 · 保留 ${fmt(CONFIG.reserve)} 憨豆 · 间隔 ${CONFIG.interval} 秒`);
    }
    if (CONFIG.notifyBigPrize) {
        log(`🎉 大奖推送：已启用（命中 邀请 / VIP / ≥ ${fmt(CONFIG.bigPrizeMinBeans)} 憨豆 立即通知）`);
    }
    if (CONFIG.reportIntervalMinutes > 0) {
        log(`📊 定期简报：每隔 ${CONFIG.reportIntervalMinutes} 分钟推送一次`);
    }

    const lottery = new Lottery(cookie);
    guardExit(lottery);

    try {
        await lottery.run();
    } catch (error) {
        report(`❌ ${error?.message || error}`);
        lottery.stopReason = `异常终止：${error?.message || error}`;
    }

    if (lottery.current.draws > 0) {
        const file = saveStats(lottery.current, lottery.total);
        if (file) report(`💾 统计已存到 ${file}`);
    }

    if (CONFIG.cleanMail) {
        try {
            await lottery.cleanMailbox();
        } catch (error) {
            report(`⚠️ 站内信清理失败：${error?.message || error}`);
        }
    }

    const runningTime = formatDuration(Date.now() - lottery.startedAt);
    const finalReport = renderFinalReport({
        current: lottery.current,
        total: lottery.total,
        balance: lottery.balance,
        runningTimeStr: runningTime,
        status: lottery.stopReason || (lottery.current.draws >= CONFIG.draws ? `已达到设定抽奖次数（${fmt(lottery.current.draws)} 抽）` : '正常结束')
    });

    await notify('🎡 HHCLUB 幸运大转盘｜运行总报', finalReport);

    const summary = lottery.summary();
    raw(`\n${'─'.repeat(40)}\n${summary}`);
}

main().catch(error => {
    log(`❌ 脚本异常：${error?.stack || error?.message || error}`);
    process.exit(1);
});

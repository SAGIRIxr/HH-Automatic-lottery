// ==UserScript==
// @name         HHCLUB 自动抽奖 · 情绪价值拉满版
// @namespace    http://tampermonkey.net/
// @version      1.33.0
// @description  HHCLUB 自动抽奖增强版 · 分奖项中奖次数统计 · 一抽到底 · 实时余额 · 站内信清理
// @author       Timqaq, JIEDIAO
// @match        https://hhanclub.net/lucky.php
// @grant        none
// @homepageURL  https://github.com/SAGIRIxr/HH-Automatic-lottery
// @supportURL   https://github.com/SAGIRIxr/HH-Automatic-lottery/issues
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    /* =========================================================
       基础配置
    ========================================================= */

    const SITE_ORIGIN = 'https://hhanclub.net';
    const LOTTERY_PAGE = `${SITE_ORIGIN}/lucky.php`;
    const LOTTERY_API = `${SITE_ORIGIN}/plugin/lucky-draw`;

    const STATS_KEY = 'hhanclub_lottery_stats_v4';
    const LEGACY_STATS_KEY = 'hhanclub_lottery_stats_v3';
    const SETTINGS_KEY = 'hhanclub_lottery_settings_v1';

    /* 抽奖间隔允许填小数，但只认到两位 —— 再细没有意义，
       也免得 0.1+0.2 这类浮点尾巴写进设置里。 */
    function normalizeInterval(raw, fallback) {
        const value = typeof raw === 'number' ? raw : parseFloat(raw);
        const seconds = Number.isFinite(value) ? value : fallback;
        return Math.min(
            CONFIG.maxInterval,
            Math.max(CONFIG.minInterval, Math.round(seconds * 100) / 100)
        );
    }

    /* 3 → 「3」，3.5 → 「3.5」，3.25 → 「3.25」；不留没用的 0 */
    function intervalText(seconds) {
        return String(Math.round(seconds * 100) / 100);
    }

    /* 转盘缓冲（毫秒），允许负值 —— 服务端在请求路上就开始计时了 */
    function normalizeBufferMs(raw, fallback) {
        const value = parseInt(raw, 10);
        const ms = Number.isFinite(value) ? value : fallback;
        return Math.min(CONFIG.maxBufferMs, Math.max(CONFIG.minBufferMs, ms));
    }

    const CONFIG = {
        // 抽奖间隔允许范围（秒）
        minInterval: 0.5,
        maxInterval: 300,
        /* 站点的冷却窗口 = 上一次抽奖返回的 data.duration（转盘转多久）。
           2026-08-21 在 lucky.php 上实测：

               上一抽 duration 7666ms → 7211ms 才放行
               上一抽 duration 3976ms → 4322ms 就放行

           duration 是 3.0 ~ 8.0 秒的均匀随机数（100 抽样本：最小 3065、
           中位 5917、最大 7997，各 500ms 分桶几乎等频；和抽奖节奏、和前
           一次的值都不相关，相关系数 -0.06）。所以任何固定间隔都躲不掉
           「不要重复点击」—— 填 5.1 秒时超过一半的抽会撞上。

           跟着 duration 排队才是对的：同样 100 抽，0 次被拒。

           两个能再抠时间的实测事实：
           1. 服务端从「受理请求」那一刻起计时，响应回到我们手里时它已经
              计了半个往返（~130ms）。所以计时起点用「发出请求」的时刻，
              缓冲设 0 甚至负值都是可行的 —— 用户实测缓冲 0 没被拒。
           2. 被「不要重复点击」挡回不会重置服务端的计时（边界探测时连吃
              16 个拒绝后照样按原时刻放行），被拒也不扣憨豆。所以贴边
              失手的代价只是一个空请求，300ms 后补一枪就行，不必再等
              一个完整周期。 */
        minBufferMs: -500,
        maxBufferMs: 5000,
        // 被「不要重复点击」挡回后多久补一枪
        rateLimitRetryMs: 300,
        // 自适应模式下还没拿到第一个 duration 时先按这个等（取实测中位数）。
        // 正常只有第一抽失败时才轮得到它 —— 第一抽本来就不用等，
        // 抽成了下一轮就有真的 duration 了
        blindGapMs: 5000,
        // 冷却剩多久不知道时（本轮还没成功过，比如开抽前刚手动转过一把）
        // 补枪的起步值。残留冷却最长 8 秒，300ms 连打纯属白打，
        // 1 秒起步配上阶梯退避正好覆盖
        blindRetryMs: 1000,
        // 被限流时的退避策略
        backoffAfterErrors: 3,
        backoffFactor: 1.5,
        maxBackoffMs: 30000,
        /* 挂机是无人值守的，所以不因为「失败几次」停机 —— 站点重启、
           网线抖一下、CDN 抽风，人不在跟前就永远停在那儿了。
           改成一直重试，但每 retryStepEvery 次抬一档等待时间：

               300 300 300 · 450 450 450 · 675 675 675 …

           一路乘到 maxRetryMs 封顶。站点真挂了也就是每 5 分钟探一次，
           压力可以忽略；站点一恢复，下一次探测就接上了。 */
        retryStepEvery: 3,
        retryStepFactor: 1.5,
        maxRetryMs: 300000,
        // 接口报错 / 网络断的重试基数。比限流那 300ms 大 —— 限流是
        // 「差一点点」，这类是真出事了，没必要贴着打
        errorRetryMs: 1000,
        // 连续失败到这个数就提醒一声（只提醒，不停机）
        stuckWarnEvery: 10,
        /* 后台保活。浏览器对不可见的标签页有三道收紧：
           1. 定时器最小间隔被压到 1 秒（对我们 5~8 秒的节奏没影响）
           2. 待够 5 分钟后转入 intensive throttling，定时器每分钟才跑一次
              —— 这个会把挂机拖成龟速
           3. 更狠的是 freeze / discard，整个页面被冻住甚至丢掉，脚本直接没了

           正在出声的标签页不吃后面两条。所以开抽时挂一个几乎无声的
           振荡器，停抽就关掉。音量取一个非零的极小值 —— 真的 0 或者
           muted 会被判定成「没在播」，白挂。 */
        keepAliveGain: 0.0001,
        // 看门狗：多久没推进就认为被节流了，回来时补一次校准
        watchdogIdleMs: 90000,
        // 日志保留条数
        logLimit: 50,
        // 大奖名册保留条数。大奖几千抽才碰一次，留久一点，
        // 它跟着历史统计一起存，换会话、关页面都不丢
        jackpotLogLimit: 100,
        // 导入台账最多记这么多条，够认出重复了，再多就是负担
        importLedgerLimit: 60,
        /* 大奖全屏庆祝停留多久。够截图是第一位的 —— 抽奖本身在后台
           照跑，遮罩多留一会儿不耽误事。也可以随手点掉或按 Esc。 */
        jackpotHoldMs: 15000,
        // 官方爆率低于这个值的奖品算大奖，走全屏庆祝。
        // 现奖池里够格的是 VIP（0.02%）和 780,000 憨豆（0.11%），
        // 邀请（0.38%）刚好不算 —— 大奖太廉价就不叫大奖了。
        jackpotMaxRate: 0.002,
        // 读不到奖池时的兜底判定：VIP，或单笔十万以上的憨豆
        jackpotBeansFloor: 100000,
        // 读不到站点公布的折算金额时用这个兜底
        vipSwapFallbackBeans: 1000000,
        /* 判定折算的主证据是余额：站点真发了那笔憨豆，账面必然多出接近
           这个数；发的是天数，账面只有做种那点零头。要求至少多出公布金额
           的这个比例才算折算。 */
        vipSwapMinDriftRatio: 0.5,
        /* 等级读不到时光有「多了一大笔」还不够 —— 奖池里有 780,000 那一档，
           它一出就能把余额差顶过上面那个门槛。所以这种情况要求余额变动
           落在公布金额附近的窄带里，宁可漏记也不乱记。 */
        vipSwapTolerance: 20000,
        // 个人页，用来读等级
        userCpPageForId: '/usercp.php',
        // 每抽多少次回服务端校准一次余额，纠正本地估算的累计漂移
        balanceSyncEveryDraws: 25,
        // 校准撞车时最多等多久让开（手动点 🔄 正好和自动校准撞上）
        calibrationWaitMs: 15000,

        // ---- 站内信清理 ----
        mailboxPage: '/messages.php',
        // 只有主题里带这几个字的才会被删。收件箱里还混着「种子被删除」
        // 「憨豆 改变」这类真要看的信，宁可漏删也不能误删。
        lotteryMailKeyword: '幸运大转盘',
        // 翻页上限。每页显示多少封是用户自己在站点设置里定的（见过 10 封的），
        // 所以页数可能很多，这里只是防站点改版后无限翻下去的兜底
        mailboxMaxPages: 600,
        // 反复清第一页的轮数上限，同样是因为一页可能只有 10 封
        mailSweepMaxRounds: 20,
        // 网站设定页，每页站内信条数（pmnum）在这里
        userCpPage: '/usercp.php',
        // 建议调到的每页条数
        mailPageSizeTarget: 100,
        // 收件箱超过这么多页才值得提议改设置，只有一两页的没必要打扰
        mailPageSizeAskAfterPages: 3,
        // 一次 POST 提交多少个 id
        mailDeleteChunk: 100
    };

    /* 奖项分类元数据：决定明细列表的图标 / 名称 / 单位 */
    /* 站点奖池里 type 1001 的 typeText 写作「魔力」，但它的图标是 bean_icon，
       消耗侧也叫憨豆 —— 那就是同一种货币，NexusPHP 的默认叫法没改干净。
       所以魔力一律归到 beans。magic 只为兼容早期版本存下来的数据保留。 */
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

    const PRIZE_ORDER = ['beans', 'magic', 'invite', 'rainbow', 'vip', 'makeup', 'upload', 'rename', 'unknown'];

    /* =========================================================
       运行时状态
    ========================================================= */

    let singleCost = 2000;
    let beanBalance = 0;
    let domBalanceSeen = null;
    let domCostSeen = null;
    let running = false;
    // 限流和接口错误分开计数：两者的重试基数不一样，混在一起数会让
    // 「差一点点」的限流和「真出事了」的报错互相污染退避档位。
    let errorStreak = 0;
    let rateLimitStreak = 0;
    let dynamicInterval = 6800;
    // 站点最近一次给的转盘时长，就是下一抽的冷却下限
    let lastDurationMs = 0;
    // 上一次抽奖请求「发出」的时刻 —— 服务端的冷却从受理那刻起算，
    // 等待时间要从这里量，处理响应花掉的时间不用重复等
    let lastDrawSentAt = 0;
    // 被限流后下一次等待的覆盖值（快速补枪），用一次就清
    let quickRetryMs = 0;
    /* 中了大奖、且开了「中奖即停」时，把奖品文案暂存在这里。
       不当场停 —— VIP 那一注还要回站点核一下是不是被换成了憨豆，
       停早了这笔账就记岔了。等那件事办完再停。 */
    let pendingJackpotStop = null;
    // 后台保活用的音频节点
    let keepAliveCtx = null;
    // 最近一次循环推进的时刻，看门狗据此判断是不是被冻住过
    let lastTickAt = 0;
    let roundStartDraws = 0;
    let sleepTimer = null;
    let sleepResolve = null;
    // 距上次服务端校准过了多少抽，用来决定什么时候再校准一次
    let drawsSinceCalibration = 0;
    let calibrating = false;
    // 站内信清理是异步的，加把锁免得自动清和手动清撞一起
    let cleaningMail = false;
    let mailCleaned = 0;

    let settings = {
        interval: 6.8,
        followDuration: true,
        bufferMs: 0,
        maxCount: 10,
        viewMode: 'current',
        animation: true,
        detailOpen: 'none',
        drainMode: false,
        reserveBeans: 0,
        stopOnJackpot: false,
        autoCleanMail: false,
        mailPageSizePrompted: false,
        panelLeft: null,
        panelTop: null
    };

    let currentStats = emptyStats();
    let totalStats = emptyStats();

    /* =========================================================
       小工具
    ========================================================= */

    const $ = id => document.getElementById(id);

    function setText(id, value) {
        const element = $(id);
        if (element) element.textContent = value;
    }

    function on(id, event, handler) {
        const element = $(id);
        if (element) element.addEventListener(event, handler);
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /* 数字格式化：整数加千分位，小数最多保留两位 */
    function fmt(value) {
        const number = Number(value) || 0;
        return Number.isInteger(number)
            ? number.toLocaleString()
            : number.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }

    /* 从文本里取第一个数字，兼容 "1,000" 这种千分位写法 */
    function firstNumber(text) {
        const match = String(text).match(/(\d[\d,]*(?:\.\d+)?)/);
        return match ? parseFloat(match[1].replace(/,/g, '')) : null;
    }

    function decodeUnicode(str) {
        if (typeof str !== 'string') return str;
        try {
            return str.replace(/\\u[\dA-F]{4}/gi, match =>
                String.fromCharCode(parseInt(match.replace(/\\u/g, ''), 16))
            );
        } catch (error) {
            return str;
        }
    }

    /* =========================================================
       后台保活

       挂机是无人值守的，标签页十有八九被切到后台。浏览器会把后台页
       的定时器压到每分钟一次（intensive throttling），甚至直接冻结或
       丢弃整个页面 —— 醒来发现一晚上只抽了几十次，或者脚本压根没了。

       正在播放音频的标签页不受这两条限制。所以开抽时挂一个听不见的
       振荡器，停抽就拆掉。
    ========================================================= */

    function startKeepAlive() {
        if (keepAliveCtx) return;

        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;

        try {
            const ctx = new Ctx();
            const oscillator = ctx.createOscillator();
            const gain = ctx.createGain();

            // 不能是 0：静音轨会被当成「没在播」，保活就失效了
            gain.gain.value = CONFIG.keepAliveGain;
            oscillator.frequency.value = 20;      // 低到基本听不见
            oscillator.connect(gain);
            gain.connect(ctx.destination);
            oscillator.start();

            keepAliveCtx = { ctx, oscillator, gain };

            // 点「开始抽奖」本身就是用户手势，正常能直接播；
            // 万一还是被 autoplay 策略拦下，恢复一下
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        } catch (error) {
            keepAliveCtx = null;
        }
    }

    function stopKeepAlive() {
        if (!keepAliveCtx) return;
        const { ctx, oscillator } = keepAliveCtx;
        keepAliveCtx = null;
        try {
            oscillator.stop();
            ctx.close();
        } catch (error) {
            // 已经关掉了，无所谓
        }
    }

    /* 标签页被切回来时看一眼：要是刚才被冻了很久，本地估算的余额
       多半已经飘了，顺手校准一次。 */
    function onVisibilityBack() {
        if (!running || document.hidden) return;

        const idle = Date.now() - lastTickAt;
        if (lastTickAt && idle > CONFIG.watchdogIdleMs) {
            addLog(`⏰ 标签页刚才被浏览器按住了 ${intervalText(idle / 1000)} 秒，`
                + '已回服务端校准余额', 'warning');
            calibrateBalance({ quiet: true }).catch(() => {});
        }

        // 有些浏览器切回前台会把 AudioContext 挂起，接着挂机就没保活了
        if (keepAliveCtx?.ctx?.state === 'suspended') {
            keepAliveCtx.ctx.resume().catch(() => {});
        }
    }

    /* 可中断的等待：停止抽奖时立刻唤醒，不用等满一个间隔 */
    function sleep(ms) {
        return new Promise(resolve => {
            sleepResolve = resolve;
            sleepTimer = setTimeout(() => {
                sleepTimer = null;
                sleepResolve = null;
                resolve();
            }, ms);
        });
    }

    function cancelSleep() {
        if (sleepTimer) {
            clearTimeout(sleepTimer);
            sleepTimer = null;
        }
        if (sleepResolve) {
            const resolve = sleepResolve;
            sleepResolve = null;
            resolve();
        }
    }

    /* =========================================================
       统计数据结构

       current 与 total 完全同构，渲染逻辑只需要写一份：
         draws  抽奖次数
         cost   累计消耗憨豆
         gains  各类奖品累计数值
         prizes 分奖项统计 { 类别: { count, value, tiers: { 档位: 次数 } } }
         raw    原始奖品文案计数，站点改文案时作为兜底
    ========================================================= */

    function emptyStats() {
        return {
            version: 4,
            draws: 0,
            cost: 0,
            gains: { beans: 0, magic: 0, invite: 0, rainbow: 0, vip: 0, makeup: 0, upload: 0, rename: 0 },
            prizes: {},
            raw: {},
            // 大奖名册：[{ at, text }]，新的在前
            jackpots: [],
            /* 这份统计的「血脉编号」。备份文件带着它出门，导回来的时候
               就能认出这是自己的记录，而不是别人另起炉灶的一份。 */
            originId: null,
            // 并进来过的备份台账：[{ exportId, originId, draws, at }]
            imports: [],
            firstAt: null,
            lastAt: null
        };
    }

    function randomId() {
        return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
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

        // 早期版本把魔力当成独立奖项存过，这里合回 beans，
        // 免得同一种憨豆在明细里split成两行、盈亏还少算一半。
        Object.entries(data.prizes || {}).forEach(([type, bucket]) => {
            const target = type === 'magic' ? 'beans' : type;
            const merged = ensureBucket(stats, target);
            merged.count += Number(bucket?.count) || 0;
            merged.value += Number(bucket?.value) || 0;

            const swapped = Number(bucket?.swappedBeans) || 0;
            if (swapped) merged.swappedBeans = (merged.swappedBeans || 0) + swapped;
            Object.entries(bucket?.tiers || {}).forEach(([label, count]) => {
                merged.tiers[label] = (merged.tiers[label] || 0) + (Number(count) || 0);
            });
        });

        stats.raw = { ...(data.raw || {}) };

        stats.originId = typeof data.originId === 'string' ? data.originId : null;
        stats.imports = (Array.isArray(data.imports) ? data.imports : [])
            .filter(item => item && (item.exportId || item.originId))
            .map(item => ({
                exportId: item.exportId ? String(item.exportId) : null,
                originId: item.originId ? String(item.originId) : null,
                draws: Number(item.draws) || 0,
                at: Number(item.at) || 0
            }))
            .slice(-CONFIG.importLedgerLimit);

        // 老版本没有这个字段，读到就是空的，不影响其余统计
        stats.jackpots = (Array.isArray(data.jackpots) ? data.jackpots : [])
            .filter(item => item && item.text)
            .map(item => ({ at: Number(item.at) || 0, text: String(item.text) }))
            .slice(0, CONFIG.jackpotLogLimit);

        return stats;
    }

    function saveStats(stats) {
        try {
            localStorage.setItem(STATS_KEY, JSON.stringify(stats));
        } catch (error) {
            console.error('HHCLUB 保存统计失败:', error);
        }
    }

    /* 头一次读到没有血脉编号的统计就补一个并落盘 —— 之后每份备份都带着它，
       导回来时才认得出「这是同一条记录线」。 */
    function stampOrigin(stats) {
        if (!stats.originId) {
            stats.originId = randomId();
            saveStats(stats);
        }
        return stats;
    }

    function loadStats() {
        try {
            const raw = localStorage.getItem(STATS_KEY);
            if (raw) return stampOrigin(normalizeStats(JSON.parse(raw)));

            const migrated = migrateLegacyStats();
            if (migrated) {
                saveStats(migrated);
                return stampOrigin(migrated);
            }
        } catch (error) {
            console.error('HHCLUB 读取统计失败:', error);
        }
        return emptyStats();
    }

    /* 把 v3 的历史数据迁移过来，原有累计值一条都不丢。
       v3 的 totalPrizeStats 是「原始文案 → 次数」，正好能重建分奖项统计。 */
    function migrateLegacyStats() {
        const raw = localStorage.getItem(LEGACY_STATS_KEY);
        if (!raw) return null;

        let old;
        try {
            old = JSON.parse(raw);
        } catch (error) {
            return null;
        }

        const stats = emptyStats();
        stats.draws = Number(old.totalLotteryCount) || 0;
        stats.cost = Number(old.totalCost) || 0;
        stats.gains.beans = Number(old.totalBeansWon) || 0;
        stats.gains.invite = Number(old.totalInvites) || 0;
        stats.gains.rainbow = Number(old.totalRainbowDays) || 0;
        stats.gains.vip = Number(old.totalVipDays) || 0;
        stats.gains.makeup = Number(old.totalMakeupCards) || 0;
        stats.gains.upload = Number(old.totalUploadGB) || 0;

        Object.entries(old.totalPrizeStats || {}).forEach(([text, count]) => {
            const times = Number(count) || 0;
            if (times <= 0) return;

            const prize = parsePrizeText(text);
            const bucket = ensureBucket(stats, prize.type);
            bucket.count += times;
            bucket.value += prize.value * times;
            bucket.tiers[prize.label] = (bucket.tiers[prize.label] || 0) + times;
            stats.raw[text] = (stats.raw[text] || 0) + times;
        });

        stats.migratedFrom = 'v3';
        console.info('HHCLUB 已从 v3 迁移历史统计');
        return stats;
    }

    function ensureBucket(stats, type) {
        if (!stats.prizes[type]) {
            stats.prizes[type] = { count: 0, value: 0, tiers: {} };
        }
        return stats.prizes[type];
    }

    /* 历史统计每次都基于 localStorage 最新值做读-改-写，
       这样多个标签页同时抽奖不会互相覆盖。 */
    function commitTotal(mutate) {
        const stats = loadStats();
        mutate(stats);
        stats.lastAt = Date.now();
        if (!stats.firstAt) stats.firstAt = stats.lastAt;
        saveStats(stats);
        totalStats = stats;
    }

    /* =========================================================
       设置持久化
    ========================================================= */

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (raw) Object.assign(settings, JSON.parse(raw));
        } catch (error) {
            console.error('HHCLUB 读取设置失败:', error);
        }

        // 存下来的值可能来自旧版本、别的合法区间，或者被手改过。
        // 不在这里收敛的话，输入框会显示一个和实际生效值不一样的数字。
        settings.interval = normalizeInterval(settings.interval, 6.8);
        settings.followDuration = settings.followDuration !== false;
        settings.bufferMs = normalizeBufferMs(settings.bufferMs, 0);
        settings.maxCount = Math.max(1, parseInt(settings.maxCount, 10) || 10);
        if (settings.viewMode !== 'total') settings.viewMode = 'current';
        if (settings.detailOpen !== 'all') settings.detailOpen = 'none';
        settings.animation = settings.animation !== false;
        // 这个默认关：挂机的人多半不希望半夜被一注 780,000 停在那儿
        settings.stopOnJackpot = settings.stopOnJackpot === true;
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (error) {
            console.error('HHCLUB 保存设置失败:', error);
        }
    }

    /* =========================================================
       奖品解析

       返回 { type, name, value, unit, label }
       label 是明细列表里的档位名，例如 "500 憨豆" / "3 天"
    ========================================================= */

    function parsePrizeText(text) {
        const source = String(text || '').trim();
        const compact = source.replace(/\s+/g, ' ');
        const fallback = { type: 'unknown', name: '其他奖品', value: 0, unit: '', label: compact || '未知奖品' };

        if (!compact) return fallback;

        const rules = [
            // 「魔力 5000」和「5000 憨豆」是同一件事
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
                // 上传量带单位，TB 统一折算成 GB
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
                name: meta.name,
                value,
                unit: meta.unit,
                label: `${fmt(value)}${meta.unit ? ' ' + meta.unit : ' ' + meta.name}`
            };
        }

        return fallback;
    }

    /* =========================================================
       奖池与官方爆率

       抽奖页的内联脚本里带着完整奖池。爆率字段站点给过两种写法，
       也可能一个都不给（2026-08-19 起就是这样），具体见 poolProbabilities。
       读不到爆率时官方对比整块降级，实测统计和抽奖本身都不受影响。
    ========================================================= */

    let prizePool = null;

    /* 从任意一份 lucky.php 文档里抠出奖池。解析失败返回 null，
       调用方据此区分「没读到」和「读到了一个空奖池」。 */
    function parsePrizePoolFrom(doc) {
        let raw = null;
        for (const script of doc.querySelectorAll('script:not([src])')) {
            const match = script.textContent.match(/\blet\s+prizes\s*=\s*(\[[\s\S]*?\])\s*;/);
            if (match) {
                raw = match[1];
                break;
            }
        }
        if (!raw) return null;

        let list;
        try {
            list = JSON.parse(raw);
        } catch (error) {
            return null;
        }
        if (!Array.isArray(list)) return null;

        // 奖池文案拼法和接口返回的 prize_text 一致（typeText + ' ' + amountText），
        // 所以档位 label 天然对得上，可以直接按 label 匹配。
        const rates = poolProbabilities(list);

        return list.map((item, index) => {
            const prize = parsePrizeText(`${item.typeText || ''} ${item.amountText || ''}`);
            return {
                type: prize.type,
                label: prize.label,
                value: prize.value,
                probability: rates[index]
            };
        });
    }

    /* 站点公布爆率的方式变过：早先每项都带一个算好的 probability_real，
       后来这个字段被撤掉，只剩原始权重 probability。两种都认 ——
       有 probability_real 就直接用，没有就拿权重归一化。归一化对
       「本来就是概率」的输入是恒等变换，所以一套代码覆盖两种情况，
       而且用权重算精度更高（probability_real 只有四位小数）。
       两个字段都没有时返回全 0，上层据此整块降级。 */
    function poolProbabilities(list) {
        const real = list.map(item => Number(item.probability_real));
        if (real.every(Number.isFinite) && real.some(value => value > 0)) return real;

        const weights = list.map(item => {
            const value = Number(item.probability);
            return Number.isFinite(value) && value > 0 ? value : 0;
        });

        const total = weights.reduce((sum, value) => sum + value, 0);
        if (total > 0) return weights.map(value => value / total);

        return list.map(() => 0);
    }

    /* 「VIP 或以上等级」说的是 NexusPHP 的 class 序号。站点可以把等级名字
       改得面目全非（本站发布员叫「俺不中类」），但内核生成的东西没改：

           <img alt="发布员" src="pic/uploader.gif" />
           <span class='Uploader_Name font-bold'>俺不中类</span>

       CSS 类名是 {ClassName}_Name，比图标文件名可靠 —— 图标是站点资源，
       随时能换皮，类名是内核按 class 序号拼出来的。两个都收，类名优先。

       键统一小写。同一等级两种写法都列（图标 veteran / 类名 veteranuser），
       免得站点哪边改了就整个判不出来。

       序号照 NexusPHP 的 UC_* 常量。peasant 是 0 —— H&R 不达标被降级的
       农民，挂机刷抽奖的号最容易掉进去。线上就是因为表里没有它，
       等级判定退化成靠余额猜，给一个非 VIP 的号凭空记了一百万。 */
    const CLASS_RANK = {
        peasant: 0,
        user: 1,
        power: 2, poweruser: 2,
        elite: 3, eliteuser: 3,
        crazy: 4, crazyuser: 4,
        insane: 5, insaneuser: 5,
        veteran: 6, veteranuser: 6,
        extreme: 7, extremeuser: 7,
        ultimate: 8, ultimateuser: 8,
        nexusmaster: 9,
        vip: 10,
        retiree: 11,
        uploader: 12,
        moderator: 13,
        coadministrator: 14, administrator: 14,
        sysop: 15,
        staffleader: 16
    };

    // true = 是 VIP 或以上，false = 不是，null = 没查出来
    let vipOrAbove = null;
    let vipClassChecked = false;

    /* 取自己的 user id。不能抓页面上第一个 userdetails 链接就走 ——
       站内信发件人、邀请列表里全是别人的链接，抓错了就会拿别人的等级
       当自己的。优先认「控制面板」这类明确指向本人的链接，实在找不到
       才退回第一个，并且只在整页只有一个候选时才敢用。 */
    async function fetchSelfUserId() {
        const response = await fetch(CONFIG.userCpPageForId, { credentials: 'include' });
        if (!response.ok) return null;

        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');

        // usercp 顶部的用户名链接带 class="User_Name"（NexusPHP 的等级色块）
        const named = doc.querySelector('a[href*="userdetails.php?id="] > b, a.User_Name[href*="userdetails.php?id="]');
        const owner = named?.closest('a') || named;
        const fromOwner = owner?.getAttribute('href')?.match(/id=(\d+)/);
        if (fromOwner) return fromOwner[1];

        const ids = new Set(
            Array.from(doc.querySelectorAll('a[href*="userdetails.php?id="]'))
                .map(link => link.getAttribute('href').match(/id=(\d+)/)?.[1])
                .filter(Boolean)
        );
        return ids.size === 1 ? [...ids][0] : null;
    }

    /* 从个人页里读出 class 序号。读不出返回 null。 */
    function parseClassRank(html) {
        // 先把范围收到「等级：」那一段，免得页面别处的图标混进来
        const at = html.search(/等级\s*[：:]/);
        const scope = at >= 0 ? html.slice(at, at + 400) : html;

        const candidates = [];
        const byClass = scope.match(/class=['"][^'"]*?\b([A-Za-z]+)_Name\b/);
        if (byClass) candidates.push(byClass[1]);

        const byIcon = scope.match(/pic\/(\w+)\.(?:gif|png|svg|webp)/i);
        if (byIcon) candidates.push(byIcon[1]);

        for (const name of candidates) {
            const rank = CLASS_RANK[name.toLowerCase()];
            // 农民是 0，不能用真假判断，否则等于没读到
            if (rank !== undefined) return rank;
        }
        return null;
    }

    async function checkVipOrAbove() {
        if (vipClassChecked) return vipOrAbove;

        try {
            const id = await fetchSelfUserId();
            if (!id) return null;

            const response = await fetch(`/userdetails.php?id=${id}`, { credentials: 'include' });
            if (!response.ok) return null;

            const rank = parseClassRank(await response.text());
            if (rank === null) return null;

            vipOrAbove = rank >= CLASS_RANK.vip;
            // 只在真查出来时才记住。查失败就别记 —— 记了的话这一整个
            // 会话都不会再试，后面再中 VIP 只能退回余额差去猜。
            vipClassChecked = true;
            return vipOrAbove;
        } catch (error) {
            return null;
        }
    }

    /* 折算金额是站点明文印在抽奖页上的：
         「当中奖 [VIP] 时，如果用户已经是 VIP 或以上等级，奖励憨豆： 1000000」
       必须读它，不能拿余额差当金额 —— 憨豆还会因为做种持续增长，
       两次读数之间涨的那几十点会被当成中奖收入记进去
       （线上真出现过「1,000,060 憨豆」这种不存在的档位）。 */
    function parseVipSwapBeansFrom(doc) {
        const text = doc.body ? doc.body.textContent || '' : '';
        const match = text.match(/当中奖\s*\[?\s*VIP\s*\]?[^当]{0,80}?奖励憨豆[：:]\s*([\d,]+)/i);
        if (!match) return 0;

        const value = Number(match[1].replace(/,/g, ''));
        return Number.isFinite(value) && value > 0 ? value : 0;
    }

    let vipSwapBeans = 0;

    function readVipSwapBeans() {
        if (!vipSwapBeans) vipSwapBeans = parseVipSwapBeansFrom(document);
        return vipSwapBeans || CONFIG.vipSwapFallbackBeans;
    }

    function readPrizePool() {
        if (prizePool) return prizePool;
        prizePool = parsePrizePoolFrom(document) || [];
        return prizePool;
    }

    /* 奖池指纹，用来判断站点有没有偷偷调过爆率 */
    function poolFingerprint(pool) {
        return (pool || []).map(item => `${item.type}|${item.label}|${item.probability}`).sort().join(';');
    }

    /* 奖池还在但一项爆率都读不到 —— 站点 2026-08-19 把 probability 和
       probability_real 双双撤掉了，页面上只剩排序用的 priority。
       官方对比这块只能停用，说一声，免得以为是脚本坏了。 */
    let opaquePoolWarned = false;
    function warnIfPoolOpaque() {
        if (opaquePoolWarned) return;
        const pool = readPrizePool();
        if (!pool.length || pool.some(item => item.probability > 0)) return;

        opaquePoolWarned = true;
        addLog('ℹ️ 站点已不再公布奖品爆率，官方对比停用', 'warning');
        addLog('📊 实测统计不受影响，样本够大时占比就是爆率', 'info');
    }

    /* 官方爆率查表：按类别汇总一份，按具体档位汇总一份 */
    function officialRates() {
        const byType = {};
        const byTier = {};
        const pool = readPrizePool();

        // 一项都读不到爆率时返回空表：宁可整块不显示，
        // 也不要摆一排「官方 0.00%」让人以为是站点真的把爆率调成了 0
        if (!pool.some(item => item.probability > 0)) return { byType, byTier };

        pool.forEach(item => {
            byType[item.type] = (byType[item.type] || 0) + item.probability;
            const key = `${item.type}|${item.label}`;
            byTier[key] = (byTier[key] || 0) + item.probability;
        });

        return { byType, byTier };
    }

    /* 这一注算不算大奖。优先用站点公布的爆率判定，读不到奖池时退回硬规则。 */
    function isJackpot(prize) {
        const pool = readPrizePool();
        const hit = pool.find(item => item.type === prize.type && item.label === prize.label);

        // 爆率读得到才按爆率判。站点撤掉爆率字段时全表都是 0，
        // 那就当没读到走硬规则，否则大奖特效会跟着一起失效。
        if (hit && hit.probability > 0) return hit.probability <= CONFIG.jackpotMaxRate;

        return prize.type === 'vip'
            || (prize.type === 'beans' && prize.value >= CONFIG.jackpotBeansFloor);
    }

    /* =========================================================
       记录一次抽奖

       抽奖次数、消耗、分奖项统计一次性写入，
       避免以前 updatePrizeStats / updateCostStats 分两步导致的中间态不一致。
    ========================================================= */

    /* 把一次中奖累加进 stats。本地抽奖和同步官方记录都走这里，
       保证两条路径算出来的结构完全一致。 */
    function applyPrize(stats, prizeText, cost, prize) {
        const parsed = prize || parsePrizeText(prizeText);

        stats.draws += 1;
        stats.cost += cost;

        if (parsed.type !== 'unknown') {
            stats.gains[parsed.type] = (stats.gains[parsed.type] || 0) + parsed.value;
        }

        const bucket = ensureBucket(stats, parsed.type);
        bucket.count += 1;
        bucket.value += parsed.value;
        bucket.tiers[parsed.label] = (bucket.tiers[parsed.label] || 0) + 1;

        // 接口返回的文案常带尾随空格，不 trim 的话同一个奖
        // 会在兜底表里留下 "魔力 100" 和 "魔力 100 " 两条 key
        const rawKey = String(prizeText).trim();
        stats.raw[rawKey] = (stats.raw[rawKey] || 0) + 1;
    }

    /* 把刚记下的那一注 VIP 改标成「已转换为憨豆」。

       这一注仍然算在 VIP 类别里 —— 转盘确实停在 VIP 那一格，
       中奖次数和爆率统计不该少这一笔。变的只有档位和收益归属：
         · VIP 档位从「7 天」换成「已转换为憨豆 1,000,000」
         · VIP 天数扣回去（没真拿到）
         · 憨豆收入加上（盈亏要算对）
       抽数和消耗都不动。 */
    function markVipSwapped(prize, beans) {
        const swappedLabel = `已转换为憨豆 ${fmt(beans)}`;

        const fix = stats => {
            stats.gains.vip = (stats.gains.vip || 0) - prize.value;
            stats.gains.beans = (stats.gains.beans || 0) + beans;

            const bucket = ensureBucket(stats, 'vip');
            bucket.value -= prize.value;
            // 和 value（天数）不是一个单位，单独存，类别行上也单独列一行
            bucket.swappedBeans = (bucket.swappedBeans || 0) + beans;
            bucket.tiers[prize.label] = (bucket.tiers[prize.label] || 0) - 1;
            if (bucket.tiers[prize.label] <= 0) delete bucket.tiers[prize.label];
            bucket.tiers[swappedLabel] = (bucket.tiers[swappedLabel] || 0) + 1;
        };

        fix(currentStats);
        commitTotal(fix);
        render();
    }

    /* 抽奖页上写着一条隐藏规则：
         「当中奖 [VIP] 时，如果用户已经是 VIP 或以上等级，奖励憨豆：1000000」
       接口返回的 prize_text 是转盘上停的那一格，未必反映这个替换，
       所以中到 VIP 就立刻回服务端核一次余额。

       定性只认余额，等级仅作佐证。等级这条线太脆：usercp 上第一个
       userdetails 链接未必是自己，「等级」二字也可能先出现在别处，
       一旦认错行就会凭空记出一百万 —— 线上真发生过：一个不是 VIP 的
       号只中过一次 VIP，账面一分没多，却被记成了折算。

       余额则是硬事实。要是哪天 prize_text 本身就返回「魔力 1000000」，
       那笔憨豆已经记进去了、估算和实际对得上，这里也不会重复计。 */
    async function reconcileVipPrize(prize) {
        const estimated = beanBalance;

        await waitForCalibrationSlot();
        if (!await calibrateBalance({ quiet: true })) {
            // 这里悄悄放过去最要命：VIP 五千抽才碰一次，漏一次就是一百万
            addLog('⚠️ 中了 VIP 但余额没核成 —— 你若本来就是 VIP，这一注的憨豆没记上', 'warning');
            return;
        }

        const drift = beanBalance - estimated;
        const beans = readVipSwapBeans();
        const eligible = await checkVipOrAbove();

        // 账面没多出那笔钱，就是真拿到了天数 —— 不管等级看着像什么
        if (drift < beans * CONFIG.vipSwapMinDriftRatio) {
            if (eligible === true) {
                addLog(`ℹ️ 中了 VIP，你的等级也够折算，但账面只变动 `
                    + `${drift > 0 ? '+' : ''}${fmt(Math.round(drift))} —— 站点发的是天数，按 VIP 记`, 'info');
            }
            return;
        }

        // 钱到账了，但等级明确不够 —— 这笔多出来的多半来自别处（赠送、
        // 别的标签页中奖）。宁可少记也不能凭空造一个一百万的档位。
        if (eligible === false) {
            addLog(`⚠️ 中了 VIP 后余额多出 ${fmt(Math.round(drift))}，但你的等级不到 VIP，`
                + '不符合折算条件 —— 这一注按 VIP 记，多出的钱另有来源', 'warning');
            return;
        }

        // 等级读不到：光有「多了一大笔」不作数。同期中一发 780,000
        // 就能顶过门槛，必须贴着公布金额才敢认。
        if (eligible === null && Math.abs(drift - beans) > CONFIG.vipSwapTolerance) {
            addLog(`⚠️ 中了 VIP 且余额多出 ${fmt(Math.round(drift))}，但读不到你的等级、`
                + `数额也对不上公布的 ${fmt(beans)} —— 这一注按 VIP 记`, 'warning');
            return;
        }

        // 金额一律按站点公布的来。drift 里混着做种收益、赠送、别的标签页的
        // 开销，当金额用会记出「1,000,060 憨豆」这种奖池里根本没有的档位。
        markVipSwapped(prize, beans);

        const extra = Math.round(drift - beans);
        addLog(`👑 你已经是 VIP，站点改发了 ${fmt(beans)} 憨豆 · 仍计为一次 VIP 中奖`, 'success');
        if (Math.abs(extra) >= 1) {
            addLog(`ℹ️ 同期余额另有 ${extra > 0 ? '+' : ''}${fmt(extra)}（做种收益 / 赠送等），未计入中奖`, 'info');
        }
    }

    function recordDraw(prizeText) {
        const prize = parsePrizeText(prizeText);
        const jackpot = isJackpot(prize);

        const apply = stats => {
            applyPrize(stats, prizeText, singleCost, prize);
            // 大奖顺手记进名册。和统计写在同一次提交里，
            // 免得中间态里出现「统计有、名册没有」
            if (jackpot) {
                stats.jackpots.unshift({ at: Date.now(), text: String(prizeText).trim() });
                stats.jackpots.length = Math.min(stats.jackpots.length, CONFIG.jackpotLogLimit);
            }
        };

        apply(currentStats);
        commitTotal(apply);

        render();

        // 开着「中奖即停」的时候，抽完这一注就收工 —— 但真正停在
        // runSingleDraw 那边做，VIP 折算之类的后续还得跑完
        const willStop = jackpot && running && settings.stopOnJackpot;
        if (willStop) pendingJackpotStop = String(prizeText).trim();

        if (jackpot) addLog(`👑 大奖！${prizeText}`, 'success');
        if (settings.animation) {
            if (jackpot) showJackpotAnimation(prizeText, willStop);
            else showWinAnimation(prizeText);
        }
    }

    /* =========================================================
       样式
    ========================================================= */

    function injectStyle() {
        const style = document.createElement('style');
        style.id = 'hhanclub-lottery-style';
        style.textContent = `
#lottery-control-panel {
    position: fixed;
    top: 24px;
    right: 24px;
    width: 380px;
    min-width: 330px;
    max-width: 560px;
    max-height: calc(100vh - 48px);
    box-sizing: border-box;
    padding: 15px;

    font-family: "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
    color: #2d1f14;

    background: #fdf8f0;
    border: 1.5px solid rgba(180, 155, 125, 0.35);
    border-radius: 18px;
    box-shadow: 0 12px 40px rgba(60, 40, 20, 0.12), 0 2px 8px rgba(60, 40, 20, 0.05);

    z-index: 2147483647;
    resize: both;
    overflow: auto;
    animation: hhPanelIn .28s ease-out;
}

#lottery-control-panel * { box-sizing: border-box; }

#lottery-control-panel::-webkit-scrollbar { width: 5px; height: 5px; }
#lottery-control-panel::-webkit-scrollbar-thumb {
    background: rgba(160, 130, 100, 0.25);
    border-radius: 8px;
}

@keyframes hhPanelIn {
    from { opacity: 0; transform: translateY(10px) scale(.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
}

/* ===== 顶部装饰 ===== */
#lottery-control-panel .hh-anniversary {
    height: 4px;
    margin: -15px -15px 12px -15px;
    border-radius: 18px 18px 0 0;
    background: linear-gradient(90deg, #e94b45, #f4a340, #ffd45c, #69a84f, #5ba9c9, #e94b45);
    background-size: 200% 100%;
    animation: hhRainbow 7s linear infinite;
}
@keyframes hhRainbow {
    from { background-position: 0% 50%; }
    to { background-position: 200% 50%; }
}

/* ===== Header ===== */
#lottery-control-panel .hh-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
    cursor: move;
    user-select: none;
}
#lottery-control-panel .hh-brand { display: flex; align-items: center; gap: 10px; }
#lottery-control-panel .hh-logo {
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    position: relative;
    flex-shrink: 0;
    border-radius: 50%;
    background: linear-gradient(180deg, #f0524c 0%, #e3423c 47%, #5d4635 48%, #5d4635 53%, #fdf8f0 54%, #fdf8f0 100%);
    border: 2.5px solid #5d4635;
    box-shadow: 0 2px 0 rgba(93,70,53,.12);
    font-size: 17px;
}
#lottery-control-panel .hh-logo::after {
    content: "";
    position: absolute;
    width: 10px;
    height: 10px;
    left: 50%;
    top: 50%;
    transform: translate(-50%,-50%);
    border: 2.5px solid #5d4635;
    border-radius: 50%;
    background: #fdf8f0;
    box-shadow: 0 0 0 2px rgba(255,255,255,.7);
}
#lottery-control-panel .hh-title {
    font-size: 15px;
    font-weight: 700;
    color: #2d1f14;
    letter-spacing: 0.2px;
}
#lottery-control-panel .hh-subtitle {
    margin-top: 1px;
    color: #a08066;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.4px;
}
#lottery-control-panel .hh-online {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    border-radius: 20px;
    background: #eef5ea;
    color: #4d8a3a;
    border: 1px solid #d0e0c4;
    font-size: 9px;
    font-weight: 700;
}
#lottery-control-panel .hh-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #5ca84a;
    box-shadow: 0 0 6px rgba(92,168,74,.4);
    animation: hhPulse 1.7s infinite;
}
@keyframes hhPulse {
    0%,100% { opacity: 1; transform: scale(1); }
    50% { opacity: .5; transform: scale(.7); }
}

/* ===== 庆典横幅 ===== */
#lottery-control-panel .hh-anniversary-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 14px;
    margin-bottom: 10px;
    border-radius: 12px;
    background: linear-gradient(135deg, #fcf0d8, #f8e6cc);
    border: 1px solid #e8d0b0;
}
#lottery-control-panel .hh-anniversary-left { display: flex; align-items: center; gap: 8px; }
#lottery-control-panel .hh-anniversary-icon { font-size: 20px; line-height: 1; }
#lottery-control-panel .hh-anniversary-title {
    font-size: 11px;
    font-weight: 700;
    color: #6a4d32;
}
#lottery-control-panel .hh-anniversary-text {
    margin-top: 1px;
    color: #a08066;
    font-size: 8px;
    font-weight: 500;
}
#lottery-control-panel .hh-four {
    font-size: 22px;
    font-weight: 900;
    color: #d4873a;
    line-height: 1;
    text-shadow: 1px 2px 0 rgba(166,102,39,.08);
}

/* ===== 余额卡片 ===== */
#lottery-control-panel .hh-balance {
    display: grid;
    grid-template-columns: 1.3fr .8fr;
    gap: 8px;
    margin-bottom: 10px;
}
#lottery-control-panel .hh-balance-card {
    padding: 10px 14px;
    border-radius: 12px;
    background: #ffffff;
    border: 1px solid #e8ddd0;
    box-shadow: 0 2px 6px rgba(110,82,48,.04);
    transition: .15s ease;
}
#lottery-control-panel .hh-balance-card:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(110,82,48,.08);
}
#lottery-control-panel .hh-label {
    color: #a08066;
    font-size: 10px;
    font-weight: 500;
    margin-bottom: 3px;
    letter-spacing: 0.2px;
}
#lottery-control-panel .hh-balance-number {
    font-size: 23px;
    font-weight: 800;
    color: #2d1f14;
    letter-spacing: -0.3px;
}
#lottery-control-panel .hh-possible {
    color: #d4873a;
    font-size: 21px;
    font-weight: 800;
}
#lottery-control-panel .hh-unit {
    color: #a08066;
    font-size: 10px;
    font-weight: 500;
}

/* ===== 统计卡片 ===== */
#lottery-control-panel .hh-stats {
    display: grid;
    grid-template-columns: repeat(2,1fr);
    gap: 8px;
    margin-bottom: 10px;
}
#lottery-control-panel .hh-stat {
    padding: 10px 12px;
    border-radius: 12px;
    background: #ffffff;
    border: 1px solid #e8ddd0;
    box-shadow: 0 2px 6px rgba(110,82,48,.04);
}
#lottery-control-panel .hh-stat-top {
    display: flex;
    justify-content: space-between;
    color: #a08066;
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.2px;
}
#lottery-control-panel .hh-stat-value {
    margin-top: 2px;
    font-size: 20px;
    font-weight: 800;
    color: #2d1f14;
}
#lottery-control-panel .hh-stat-note {
    margin-top: 2px;
    font-size: 9px;
    line-height: 1.4;
    font-weight: 600;
    color: #a08066;
    display: none;
}
#lottery-control-panel .hh-stat-note.is-on {
    display: block;
}

/* ===== 盈亏 ===== */
#lottery-control-panel .hh-profit {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    margin-bottom: 10px;
    border-radius: 12px;
    background: linear-gradient(135deg, #fcf0d8, #f8e6cc);
    border: 1px solid #e8d0b0;
}
#lottery-control-panel .hh-profit-left {
    color: #a08066;
    font-size: 10px;
    font-weight: 500;
}
#lottery-control-panel .hh-profit-value {
    margin-top: 1px;
    font-size: 19px;
    font-weight: 800;
}
#lottery-control-panel .hh-profit-rate {
    font-size: 16px;
    font-weight: 800;
}

/* ===== 区块 ===== */
#lottery-control-panel .hh-section {
    margin-bottom: 10px;
    padding: 12px 14px;
    border-radius: 12px;
    background: #ffffff;
    border: 1px solid #e8ddd0;
    box-shadow: 0 2px 6px rgba(110,82,48,.04);
}
#lottery-control-panel .hh-section-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
    font-size: 12px;
    font-weight: 700;
    color: #4d3828;
}
#lottery-control-panel .hh-section-title > span {
    color: #a08066;
    font-weight: 500;
    font-size: 10px;
}

/* ===== 设置 ===== */
#lottery-control-panel .hh-settings {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
}
#lottery-control-panel .hh-field {
    padding: 8px 10px;
    border-radius: 10px;
    background: #f8f2ea;
    border: 1px solid #e8ddd0;
}
#lottery-control-panel .hh-field label {
    display: block;
    color: #a08066;
    font-size: 9px;
    font-weight: 500;
    margin-bottom: 3px;
}
#lottery-control-panel .hh-field input,
#lottery-control-panel .hh-mode {
    width: 100%;
    color: #2d1f14;
    background: #ffffff;
    border: 1px solid #ddd0c0;
    border-radius: 7px;
    padding: 6px 8px;
    font-size: 12px;
    font-weight: 500;
    outline: none;
    transition: border-color .2s;
}
#lottery-control-panel .hh-field input:focus,
#lottery-control-panel .hh-mode:focus {
    border-color: #d4873a;
    box-shadow: 0 0 0 3px rgba(212,135,58,.1);
}

/* ===== 按钮 ===== */
#lottery-control-panel .hh-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 10px;
}
#lottery-control-panel .hh-btn {
    border: 0;
    border-radius: 10px;
    padding: 10px 8px;
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: .15s ease;
}
#lottery-control-panel .hh-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    filter: brightness(1.05);
}
#lottery-control-panel .hh-btn:active:not(:disabled) { transform: translateY(0); }
#lottery-control-panel .hh-btn:disabled { opacity: .4; cursor: not-allowed; }
#lottery-control-panel .hh-start {
    background: linear-gradient(135deg, #f4a743, #e58c32);
    box-shadow: 0 4px 14px rgba(224,139,49,.25);
}
#lottery-control-panel .hh-stop {
    background: linear-gradient(135deg, #e95b55, #cf413d);
    box-shadow: 0 4px 14px rgba(207,65,61,.18);
}

/* ===== 小按钮 ===== */
#lottery-control-panel .hh-small-actions {
    display: flex;
    gap: 6px;
    margin-top: 10px;
}
#lottery-control-panel .hh-small-btn {
    flex: 1;
    padding: 6px 5px;
    border-radius: 8px;
    border: 1px solid #ddd0c0;
    background: #f8f2ea;
    color: #8a705a;
    font-size: 9px;
    font-weight: 600;
    cursor: pointer;
    transition: .15s ease;
}
#lottery-control-panel .hh-small-btn:hover {
    background: #f0e6da;
    color: #5a4030;
    border-color: #ccbca8;
}

/* ===== 汇总奖品格 ===== */
#lottery-control-panel .hh-prizes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
}
#lottery-control-panel .hh-prize {
    min-width: 0;
    padding: 8px 10px;
    border-radius: 10px;
    background: #f8f2ea;
    border: 1px solid #e8ddd0;
}
#lottery-control-panel .hh-prize-name {
    color: #a08066;
    font-size: 9px;
    font-weight: 500;
}
#lottery-control-panel .hh-prize-value {
    margin-top: 2px;
    font-size: 14px;
    font-weight: 800;
    color: #2d1f14;
}

/* ===== 分奖项明细 ===== */
#lottery-control-panel .hh-detail-list {
    max-height: 260px;
    overflow-y: auto;
    padding-right: 2px;
}
#lottery-control-panel .hh-detail-empty {
    text-align: center;
    color: #b09a84;
    padding: 14px 10px;
    font-size: 10px;
    font-weight: 500;
}
#lottery-control-panel .hh-row {
    margin-bottom: 6px;
    padding: 7px 9px;
    border-radius: 10px;
    background: #f8f2ea;
    border: 1px solid #e8ddd0;
}
#lottery-control-panel .hh-row-head {
    display: flex;
    align-items: center;
    gap: 7px;
    cursor: pointer;
    user-select: none;
}
#lottery-control-panel .hh-row-icon {
    font-size: 13px;
    line-height: 1;
    flex-shrink: 0;
}
#lottery-control-panel .hh-row-name {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    font-weight: 700;
    color: #4d3828;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
#lottery-control-panel .hh-row-count {
    flex-shrink: 0;
    font-size: 12px;
    font-weight: 800;
    color: #d4873a;
    white-space: nowrap;
}
#lottery-control-panel .hh-row-pct {
    flex-shrink: 0;
    width: 42px;
    text-align: right;
    font-size: 10px;
    font-weight: 600;
    color: #a08066;
    white-space: nowrap;
}
#lottery-control-panel .hh-row-caret {
    flex-shrink: 0;
    width: 12px;
    text-align: center;
    font-size: 8px;
    color: #b09a84;
    transition: transform .15s ease;
}
#lottery-control-panel .hh-row.is-open .hh-row-caret { transform: rotate(90deg); }
#lottery-control-panel .hh-row-official {
    flex-shrink: 0;
    width: 46px;
    text-align: right;
    font-size: 9px;
    font-weight: 500;
    color: #b09a84;
    white-space: nowrap;
}
#lottery-control-panel .hh-row-bar {
    position: relative;
    height: 4px;
    margin-top: 5px;
    border-radius: 3px;
    background: #ece0d2;
    overflow: hidden;
}
/* 官方爆率刻度线，和实测填充条比长短 */
#lottery-control-panel .hh-row-bar-mark {
    position: absolute;
    top: -1px;
    width: 2px;
    height: 6px;
    border-radius: 1px;
    background: #6a5240;
    opacity: .55;
}
#lottery-control-panel .hh-row-bar-fill {
    height: 100%;
    border-radius: 3px;
    background: linear-gradient(90deg, #f4a743, #e58c32);
    transition: width .3s ease;
}
#lottery-control-panel .hh-row-sum {
    margin-top: 4px;
    font-size: 9px;
    font-weight: 500;
    color: #a08066;
}
#lottery-control-panel .hh-tiers {
    display: none;
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed #e0d2c0;
}
#lottery-control-panel .hh-row.is-open .hh-tiers { display: block; }
#lottery-control-panel .hh-tier {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 3px 2px 3px 20px;
    font-size: 10px;
    font-weight: 500;
    color: #6a5240;
}
#lottery-control-panel .hh-tier-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
#lottery-control-panel .hh-tier-rate {
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 500;
    color: #b09a84;
    white-space: nowrap;
}
#lottery-control-panel .hh-tier-count {
    flex-shrink: 0;
    font-weight: 700;
    color: #8a705a;
    white-space: nowrap;
}

/* ===== 日志 ===== */
#lottery-control-panel .hh-log {
    display: none;
    max-height: 150px;
    overflow-y: auto;
    padding: 8px 10px;
    border-radius: 10px;
    background: #f8f2ea;
    border: 1px solid #e8ddd0;
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 10px;
    line-height: 1.7;
    color: #2d1f14;
}


#lottery-control-panel .hh-jackpot-log {
    max-height: 132px;
    overflow-y: auto;
    padding: 4px 6px;
    border-radius: 10px;
    background: linear-gradient(180deg, #fdf3e0, #faeeda);
    border: 1px solid #e8d5bc;
}
#lottery-control-panel .hh-jackpot-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 5px;
    border-radius: 6px;
}
#lottery-control-panel .hh-jackpot-row + .hh-jackpot-row {
    border-top: 1px dashed rgba(200, 170, 130, .45);
}
#lottery-control-panel .hh-jackpot-row b {
    font-size: 11px;
    font-weight: 800;
    color: #b26a12;
    white-space: nowrap;
}
#lottery-control-panel .hh-jackpot-when {
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 9px;
    color: #a08066;
    white-space: nowrap;
}
#lottery-control-panel .hh-jackpot-legacy {
    padding: 6px 5px 3px;
    margin-top: 3px;
    border-top: 1px dashed rgba(200, 170, 130, .45);
    font-size: 9px;
    color: #a08066;
}
#lottery-control-panel .hh-jackpot-empty {
    padding: 10px 6px;
    text-align: center;
    font-size: 9px;
    color: #a08066;
}

/* ===== 中奖弹窗 ===== */
.hh-win-overlay {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%) scale(.75);
    z-index: 2147483648;
    padding: 18px 25px;
    border-radius: 16px;
    background: linear-gradient(135deg, #fdf8f0, #f8e6cc);
    border: 2px solid #d4873a;
    box-shadow: 0 16px 50px rgba(60,40,20,.2), inset 0 1px 0 rgba(255,255,255,.8);
    text-align: center;
    pointer-events: none;
    opacity: 0;
    animation: hhWinPopup 1.9s ease-out forwards;
}
.hh-win-title {
    color: #d4873a;
    font-size: 20px;
    font-weight: 900;
    margin-bottom: 4px;
}
.hh-win-prize {
    color: #2d1f14;
    font-size: 14px;
    font-weight: 700;
}
@keyframes hhWinPopup {
    0% { opacity: 0; transform: translate(-50%,-50%) scale(.65); }
    15% { opacity: 1; transform: translate(-50%,-50%) scale(1.05); }
    28% { transform: translate(-50%,-50%) scale(1); }
    78% { opacity: 1; }
    100% { opacity: 0; transform: translate(-50%,-65%) scale(.95); }
}

/* ===== 粒子 ===== */
.hh-confetti {
    position: fixed;
    z-index: 2147483649;
    pointer-events: none;
    font-size: 16px;
    animation: hhConfetti 1.4s ease-out forwards;
}
@keyframes hhConfetti {
    0% { opacity: 1; transform: translate(0,0) rotate(0deg) scale(1); }
    100% { opacity: 0; transform: translate(var(--tx), var(--ty)) rotate(var(--rot)) scale(.5); }
}

/* ===== 移动端 ===== */
@media (max-width:600px) {
    #lottery-control-panel {
        right: 10px;
        top: 10px;
        width: min(380px, calc(100vw - 20px));
        min-width: 280px;
        max-height: calc(100vh - 20px);
        padding: 14px 14px;
    }
    #lottery-control-panel .hh-anniversary {
        margin: -14px -14px 12px -14px;
    }
}

/* ===== 导入方式弹窗 ===== */
.hh-modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(40, 26, 12, .45);
    backdrop-filter: blur(2px);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
.hh-modal {
    width: min(330px, calc(100vw - 32px));
    padding: 16px;
    border-radius: 14px;
    background: linear-gradient(160deg, #fffdf8, #fdf3e4);
    border: 1px solid #e8d5bc;
    box-shadow: 0 20px 60px rgba(60, 40, 20, .3);
}
.hh-modal-title {
    font-size: 14px;
    font-weight: 800;
    color: #5a4030;
    margin-bottom: 8px;
}
.hh-modal-text {
    font-size: 11px;
    line-height: 1.7;
    color: #8a705a;
    margin-bottom: 12px;
}
.hh-modal-text b { color: #d4873a; }
.hh-modal-warn {
    padding: 8px 10px;
    margin-bottom: 10px;
    border-radius: 8px;
    border: 1px solid #e8c08a;
    background: #fdf3e2;
    font-size: 10px;
    line-height: 1.65;
    color: #8a6034;
}
.hh-modal-warn b {
    display: block;
    margin-bottom: 2px;
    font-size: 11px;
    color: #c06a20;
}
/* 「看着像」而已，别摆出和铁证一样的脸色 */
.hh-modal-warn.is-soft {
    border-color: #dcd2c4;
    background: #faf7f2;
    color: #8a705a;
}
.hh-modal-warn.is-soft b { color: #6f5a44; }
.hh-modal-btn {
    display: block;
    width: 100%;
    margin-bottom: 7px;
    padding: 9px 11px;
    border-radius: 9px;
    border: 1px solid #e8d5bc;
    background: #fffdf9;
    color: #5a4030;
    font-size: 12px;
    font-weight: 700;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
    transition: transform .12s ease, box-shadow .12s ease;
}
.hh-modal-btn span {
    display: block;
    margin-top: 2px;
    font-size: 9px;
    font-weight: 500;
    color: #a08066;
}
.hh-modal-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(120, 80, 40, .16);
}
.hh-modal-primary {
    background: linear-gradient(135deg, #f5b555, #e09030);
    border-color: #d4873a;
    color: #fff;
}
.hh-modal-primary span { color: rgba(255, 255, 255, .85); }
.hh-modal-ghost {
    margin-bottom: 0;
    padding: 7px 11px;
    background: transparent;
    border-color: transparent;
    color: #a08066;
    font-size: 11px;
    font-weight: 600;
    text-align: center;
}
.hh-modal-ghost:hover {
    transform: none;
    box-shadow: none;
    background: rgba(160, 128, 102, .1);
}

/* ===== 一抽到底 ===== */
#lottery-control-panel .hh-drain {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 8px;
    padding: 7px 9px;
    border-radius: 9px;
    background: linear-gradient(135deg, #fff4e2, #ffe9cc);
    border: 1px solid #f0cfa0;
}
#lottery-control-panel .hh-drain-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 700;
    color: #8a5a20;
    cursor: pointer;
    user-select: none;
}
#lottery-control-panel .hh-drain-toggle input {
    width: 13px;
    height: 13px;
    accent-color: #d4873a;
    cursor: pointer;
}
#lottery-control-panel .hh-drain-reserve {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: #a08066;
    font-weight: 600;
}
#lottery-control-panel .hh-drain-reserve input {
    width: 74px;
    padding: 3px 6px;
    font-size: 11px;
    font-weight: 700;
    color: #5a4030;
    border: 1px solid #e8d5bc;
    border-radius: 6px;
    background: #fffdf9;
    text-align: right;
}
#lottery-control-panel .hh-duration-info {
    flex: 0 0 auto;
    font-size: 9px;
    font-weight: 700;
    color: #5a4030;
    padding: 3px 8px;
    border: 1px solid #e8d5bc;
    border-radius: 6px;
    background: #fffdf9;
    white-space: nowrap;
}
#lottery-control-panel .hh-drain-hint {
    margin-top: 5px;
    font-size: 9px;
    line-height: 1.5;
    color: #a08066;
    display: none;
}
#lottery-control-panel .hh-drain-hint.is-on {
    display: block;
}

/* ===== 大奖全屏庆祝 ===== */
.hh-jackpot-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    /* 要能点掉，所以不能整块 pointer-events: none。
       抽奖在后台照跑，遮罩挡着的只是视线。 */
    cursor: pointer;
    background: radial-gradient(ellipse at center, rgba(70, 40, 10, .55) 0%, rgba(10, 6, 2, .82) 70%);
    animation: hhJackpotFade .45s ease-out;
}
.hh-jackpot-overlay.is-out {
    animation: hhJackpotFade .5s ease-in reverse forwards;
}
/* 背后缓慢旋转的金色光芒 */
.hh-jackpot-rays {
    position: absolute;
    width: 150vmax;
    height: 150vmax;
    background: repeating-conic-gradient(
        from 0deg,
        rgba(255, 214, 110, .20) 0deg 7deg,
        transparent 7deg 14deg
    );
    animation: hhJackpotSpin 9s linear infinite;
}
.hh-jackpot-card {
    position: relative;
    text-align: center;
    padding: 0 24px;
    animation: hhJackpotPop .7s cubic-bezier(.2, 1.5, .4, 1);
}
.hh-jackpot-kicker {
    font-size: clamp(14px, 3.4vw, 22px);
    font-weight: 800;
    letter-spacing: .5em;
    text-indent: .5em;
    color: #ffe9a8;
    text-shadow: 0 0 18px rgba(255, 190, 60, .9);
}
.hh-jackpot-prize {
    margin: 10px 0 8px;
    font-size: clamp(30px, 8vw, 68px);
    font-weight: 900;
    line-height: 1.15;
    background: linear-gradient(180deg, #fff6d0 0%, #ffd166 45%, #f0a12e 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    filter: drop-shadow(0 4px 18px rgba(255, 160, 30, .75));
}
.hh-jackpot-sub {
    font-size: clamp(11px, 2.4vw, 15px);
    font-weight: 600;
    color: rgba(255, 233, 180, .8);
}
.hh-jackpot-when {
    margin-top: 6px;
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: clamp(10px, 1.8vw, 12px);
    color: rgba(255, 233, 180, .55);
}
.hh-jackpot-close {
    margin-top: 22px;
    padding: 9px 26px;
    border: 1px solid rgba(255, 214, 110, .55);
    border-radius: 999px;
    background: rgba(255, 214, 110, .12);
    color: #ffe9a8;
    font-family: inherit;
    font-size: clamp(11px, 2vw, 14px);
    font-weight: 700;
    cursor: pointer;
    transition: background .18s, transform .18s;
}
.hh-jackpot-close:hover {
    background: rgba(255, 214, 110, .26);
    transform: translateY(-1px);
}
.hh-jackpot-hint {
    margin-top: 10px;
    font-size: clamp(9px, 1.6vw, 11px);
    color: rgba(255, 233, 180, .45);
}
.hh-firework {
    position: fixed;
    z-index: 2147483647;
    pointer-events: none;
    animation: hhFirework 2.6s cubic-bezier(.15, .7, .3, 1) forwards;
}
@keyframes hhJackpotFade {
    from { opacity: 0; }
    to   { opacity: 1; }
}
@keyframes hhJackpotSpin {
    to { transform: rotate(360deg); }
}
@keyframes hhJackpotPop {
    0%   { transform: scale(.4) rotate(-6deg); opacity: 0; }
    60%  { transform: scale(1.08) rotate(1.5deg); opacity: 1; }
    100% { transform: scale(1) rotate(0); opacity: 1; }
}
@keyframes hhFirework {
    0%   { transform: translate(0, 0) rotate(0); opacity: 1; }
    70%  { opacity: 1; }
    100% { transform: translate(var(--tx), var(--ty)) rotate(var(--rot)); opacity: 0; }
}

/* ===== 降低动画偏好 ===== */
@media (prefers-reduced-motion: reduce) {
    #lottery-control-panel,
    #lottery-control-panel .hh-anniversary,
    #lottery-control-panel .hh-dot {
        animation: none;
    }
    /* 大奖仍然给看，只是不转不飞 */
    .hh-jackpot-overlay,
    .hh-jackpot-card { animation: none; }
    .hh-jackpot-rays { display: none; }
    .hh-firework { display: none; }
}
        `;
        document.head.appendChild(style);
    }

    /* =========================================================
       面板
    ========================================================= */

    function createControlPanel() {
        if ($('lottery-control-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'lottery-control-panel';

        panel.innerHTML = `
            <div class="hh-anniversary"></div>

            <!-- Header -->
            <div class="hh-header" id="hh-title-bar">
                <div class="hh-brand">
                    <div class="hh-logo">🎁</div>
                    <div>
                        <div class="hh-title">HHCLUB 自动抽奖</div>
                        <div class="hh-subtitle">🎉 4TH ANNIVERSARY · LOTTERY</div>
                    </div>
                </div>
                <div class="hh-online">
                    <i class="hh-dot"></i>
                    READY
                </div>
            </div>

            <!-- Anniversary -->
            <div class="hh-anniversary-banner">
                <div class="hh-anniversary-left">
                    <div class="hh-anniversary-icon">
                        <img src="${SITE_ORIGIN}/pic/medal/4th.svg" style="width:44px;height:44px;" alt="4th Anniversary">
                    </div>
                    <div>
                        <div class="hh-anniversary-title">HHCLUB 四周年庆典</div>
                        <div class="hh-anniversary-text">一起庆祝 · 一起抽奖 · 好运连连</div>
                    </div>
                </div>
                <div class="hh-four">4</div>
            </div>

            <!-- Balance -->
            <div class="hh-balance">
                <div class="hh-balance-card">
                    <div class="hh-label">💰 憨豆余额</div>
                    <div class="hh-balance-number" id="bean-balance">检测中...</div>
                    <div class="hh-label" style="margin:4px 0 0;display:flex;align-items:center;gap:6px;">
                        <span id="balance-freshness" style="color:#a08066;">已校准</span>
                        <button id="refresh-balance" class="hh-small-btn"
                                style="flex:0 0 auto;width:auto;padding:2px 7px;font-size:9px;">🔄</button>
                    </div>
                    <div class="hh-label" style="margin:4px 0 0;">
                        单次消耗 <b id="single-cost" style="color:#d4873a;">2000</b> 憨豆
                    </div>
                </div>
                <div class="hh-balance-card">
                    <div class="hh-label">🎯 可抽次数</div>
                    <div>
                        <span class="hh-possible" id="max-possible">-</span>
                        <span class="hh-unit">次</span>
                    </div>
                    <div class="hh-label" style="margin-top:7px;">按当前余额计算</div>
                </div>
            </div>

            <!-- Settings -->
            <div class="hh-section">
                <div class="hh-section-title">
                    <div>⚙️ 抽奖设置</div>
                    <span id="lottery-status">等待开始</span>
                </div>

                <div class="hh-settings">
                    <div class="hh-field">
                        <label>⏱ 抽奖间隔 · 秒</label>
                        <input type="number" id="lottery-interval" value="6.8" step="0.01"
                               min="${CONFIG.minInterval}" max="${CONFIG.maxInterval}">
                    </div>
                    <div class="hh-field">
                        <label>🎯 最大抽奖次数</label>
                        <input type="number" id="max-lottery-count" value="10" min="1" max="1000">
                    </div>
                </div>

                <div class="hh-drain">
                    <label class="hh-drain-toggle">
                        <input type="checkbox" id="follow-duration">
                        <span>⚡ 自适应延迟</span>
                    </label>
                    <div class="hh-drain-reserve">
                        <span>缓冲</span>
                        <input type="number" id="duration-buffer" value="0" step="50"
                               min="${CONFIG.minBufferMs}" max="${CONFIG.maxBufferMs}">
                        <span>ms</span>
                    </div>
                </div>
                <div id="duration-hint" class="hh-drain-hint">
                    转盘转多久就等多久，上面填的间隔不生效。缓冲越小抽得越快（可为负）
                </div>
                <div class="hh-drain" style="justify-content:flex-end;">
                    <span id="duration-info" class="hh-duration-info">等第一抽后自动调节</span>
                </div>

                <div class="hh-drain">
                    <label class="hh-drain-toggle">
                        <input type="checkbox" id="drain-mode">
                        <span>🔥 一抽到底</span>
                    </label>
                    <div class="hh-drain-reserve">
                        <span>保留</span>
                        <input type="number" id="reserve-beans" value="0" min="0" step="1000">
                        <span>憨豆</span>
                    </div>
                </div>
                <div id="drain-hint" class="hh-drain-hint">
                    勾选后忽略最大次数，一直抽到余额跌破保留线为止
                </div>

                <div class="hh-drain">
                    <label class="hh-drain-toggle">
                        <input type="checkbox" id="auto-clean-mail">
                        <span>📪 自动删抽奖站内信</span>
                    </label>
                    <button id="purge-mail" class="hh-small-btn"
                            style="flex:0 0 auto;width:auto;padding:4px 10px;">🗑 立即清空</button>
                </div>
                <div id="mail-hint" class="hh-drain-hint">
                    每 ${CONFIG.balanceSyncEveryDraws} 抽顺手清一次，只删主题带「${CONFIG.lotteryMailKeyword}」的，别的信不碰
                </div>

                <div class="hh-drain">
                    <label class="hh-drain-toggle">
                        <input type="checkbox" id="stop-on-jackpot">
                        <span>🏆 中大奖就停</span>
                    </label>
                </div>
                <div id="jackpot-stop-hint" class="hh-drain-hint">
                    抽中 VIP 或 ${fmt(CONFIG.jackpotBeansFloor)} 憨豆以上就收手，留着现场对账、截图
                </div>

                <div style="display:flex;align-items:center;justify-content:space-between;margin-top:7px;">
                    <span style="font-size:10px;color:#a08066;font-weight:500;">
                        当前间隔 <b id="current-interval" style="color:#5a4030;">6.8</b> 秒
                    </span>
                    <button id="set-max-possible" class="hh-small-btn"
                            style="flex:0 0 auto;width:auto;padding:4px 10px;">
                        🎯 按余额设置
                    </button>
                </div>

                <div class="hh-actions">
                    <button id="start-lottery" class="hh-btn hh-start">🎁 开始抽奖</button>
                    <button id="stop-lottery" class="hh-btn hh-stop" disabled>🛑 停止抽奖</button>
                </div>
            </div>

            <!-- Main Stats -->
            <div class="hh-stats">
                <div class="hh-stat">
                    <div class="hh-stat-top">
                        <span>🎲 抽奖次数</span>
                        <span>DRAWS</span>
                    </div>
                    <div class="hh-stat-value" id="draw-count">0</div>
                </div>
                <div class="hh-stat">
                    <div class="hh-stat-top">
                        <span>🏆 奖项种类</span>
                        <span>TYPES</span>
                    </div>
                    <div class="hh-stat-value" id="prize-type-count">0</div>
                </div>
            </div>

            <!-- Profit -->
            <div class="hh-profit">
                <div>
                    <div class="hh-profit-left" id="profit-label">🍰 憨豆盈亏</div>
                    <div class="hh-profit-value" id="profit-loss">-</div>
                </div>
                <div style="text-align:right;">
                    <div class="hh-profit-left" id="profit-rate-label">盈亏率</div>
                    <div class="hh-profit-rate" id="profit-rate">-</div>
                </div>
            </div>

            <!-- Data -->
            <div class="hh-section">
                <div class="hh-section-title">
                    <div>📊 数据统计</div>
                    <select id="view-mode" class="hh-mode"
                            style="width:112px;padding:5px 7px;font-size:11px;">
                        <option value="current">本次数据</option>
                        <option value="total">历史总计</option>
                    </select>
                </div>

                <div class="hh-stats">
                    <div class="hh-stat">
                        <div class="hh-stat-top">
                            <span>📉 累计消耗</span>
                            <span>COST</span>
                        </div>
                        <div class="hh-stat-value" id="cost-beans">0</div>
                    </div>
                    <div class="hh-stat">
                        <div class="hh-stat-top">
                            <span>💰 获得憨豆</span>
                            <span>BEAN</span>
                        </div>
                        <div class="hh-stat-value" id="total-beans-won">0</div>
                        <div class="hh-stat-note" id="beans-swap-note"></div>
                    </div>
                </div>

                <div class="hh-prizes">
                    <div class="hh-prize">
                        <div class="hh-prize-name">📧 邀请</div>
                        <div class="hh-prize-value" id="total-invites">0</div>
                    </div>
                    <div class="hh-prize">
                        <div class="hh-prize-name">🌈 彩虹ID</div>
                        <div class="hh-prize-value" id="total-rainbow-days">0天</div>
                    </div>
                    <div class="hh-prize">
                        <div class="hh-prize-name">⭐ VIP</div>
                        <div class="hh-prize-value" id="total-vip-count">0次</div>
                    </div>
                    <div class="hh-prize">
                        <div class="hh-prize-name">🎫 补签卡</div>
                        <div class="hh-prize-value" id="total-makeup-cards">0</div>
                    </div>
                    <div class="hh-prize">
                        <div class="hh-prize-name">⬆️ 上传量</div>
                        <div class="hh-prize-value" id="total-upload">0GB</div>
                    </div>
                </div>

                <div class="hh-small-actions">
                    <button id="reset-current-data" class="hh-small-btn">↻ 重置本次</button>
                    <button id="export-stats" class="hh-small-btn">📤 导出 CSV</button>
                    <button id="backup-stats" class="hh-small-btn">💾 备份 JSON</button>
                    <button id="import-stats" class="hh-small-btn">📥 导入备份</button>
                    <button id="clear-total-data" class="hh-small-btn">🗑 清空历史</button>
                </div>
            </div>

            <!-- 分奖项明细 -->
            <div class="hh-section">
                <div class="hh-section-title">
                    <div>🎁 奖项明细</div>
                    <span id="detail-summary">共 0 抽</span>
                </div>
                <div id="detail-list" class="hh-detail-list"></div>
                <div class="hh-small-actions">
                    <button id="toggle-all-tiers" class="hh-small-btn">🔽 展开全部档位</button>
                    <button id="toggle-animation" class="hh-small-btn">🎉 中奖动画：开</button>
                </div>
            </div>

            <!-- Log -->
            <div class="hh-section">
                <div class="hh-section-title">
                    <div>📜 冒险日志</div>
                    <span>最近 ${CONFIG.logLimit} 条</span>
                </div>
                <div id="lottery-log" class="hh-log"></div>
            </div>

            <!-- Jackpot Log -->
            <div class="hh-section" style="margin-bottom:0;">
                <div class="hh-section-title">
                    <div>👑 大奖名册</div>
                    <span id="jackpot-count">-</span>
                </div>
                <div id="jackpot-log" class="hh-jackpot-log"></div>
            </div>

        `;

        document.body.appendChild(panel);
    }

    /* =========================================================
       余额 / 单次消耗
    ========================================================= */

    /* 和 getBeanBalance() 一个套路：.use-bean 不刷新页面就永远不变，
       所以只有 DOM 数字自己变过才采信。以前每次调用都无条件回读，
       校准从服务端拿回来的新价会被页面上的旧价当场冲掉。
       注意要兼容 "2,000" 这种千分位写法，否则会被截成 2。 */
    function getSingleCost() {
        const element = document.querySelector('.use-bean');
        const domValue = element ? firstNumber(element.textContent) : null;

        if (domValue !== null && domValue > 0 && domValue !== domCostSeen) {
            domCostSeen = domValue;
            singleCost = Math.round(domValue);
            setText('single-cost', fmt(singleCost));
        }

        return singleCost;
    }

    /* 站点的 lottery() 抽完只转转盘、弹窗，从不刷新 .bean-number，
       所以自动抽奖期间那个元素一直是进页面时的旧值 —— 面板上的余额和
       「最多可抽」会一路冻结。这里改成：DOM 值自己变了（刷新页面、站点
       以后加了更新）才采信，其余时间用每抽扣一次的本地估算值。 */
    function getBeanBalance() {
        const element = document.querySelector('.bean-number');
        const domValue = element ? firstNumber(element.textContent) : null;

        if (domValue !== null && domValue !== domBalanceSeen) {
            domBalanceSeen = domValue;
            beanBalance = domValue;
        }

        return beanBalance;
    }

    /* 站点抽完不刷新余额，本地估算又会随时间漂移（比如你在别的标签页手点了几抽），
       所以每隔若干抽回服务端要一次权威值。lucky.php 自己就带 .bean-number，
       不用另找接口。 */
    /* 一次请求同时拿余额和奖池。站点会不定期调整爆率
       （线上见过同一天改好几次），而奖池就在这份 HTML 里，
       顺手解析不用多发一次请求。 */
    async function fetchServerSnapshot() {
        try {
            const response = await fetch(LOTTERY_PAGE, { credentials: 'include' });
            if (!response.ok) return null;

            const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
            // 折算金额和奖池一样是站点随时能改的，顺手刷新
            const swapBeans = parseVipSwapBeansFrom(doc);
            if (swapBeans > 0) vipSwapBeans = swapBeans;

            return {
                balance: firstNumber(doc.querySelector('.bean-number')?.textContent ?? ''),
                // .use-bean 和 .bean-number 一样，不刷新页面就永远不变。
                // 一抽到底可能挂好几个小时，中途站点调价的话，停止判断
                // 会拿旧成本去算，保留线就守不住了。
                cost: firstNumber(doc.querySelector('.use-bean')?.textContent ?? ''),
                pool: parsePrizePoolFrom(doc)
            };
        } catch (error) {
            return null;
        }
    }

    /* 单抽消耗变了就换掉。这个值影响一抽到底的停止判断和全部盈亏计算，
       挂机跑着的时候尤其不能用旧的。 */
    function adoptSingleCost(cost) {
        if (cost === null || !(cost > 0)) return false;

        const next = Math.round(cost);
        if (next === singleCost) return false;

        const before = singleCost;
        singleCost = next;
        setText('single-cost', fmt(singleCost));

        // 对齐到 DOM 当前值，理由同 calibrateBalance：
        // 不对齐的话下一次 getSingleCost() 会把这里的新价冲掉
        const element = document.querySelector('.use-bean');
        const domValue = element ? firstNumber(element.textContent) : null;
        if (domValue !== null) domCostSeen = domValue;
        addLog(`💱 站点把单次消耗从 ${fmt(before)} 调成了 ${fmt(singleCost)} 憨豆`, 'warning');
        return true;
    }

    /* 爆率变了就换掉缓存。变了要说一声 —— 明细里的官方对比和大奖判定都跟着它走。 */
    function adoptPool(pool, { quiet = false } = {}) {
        if (!pool || !pool.length) return false;
        if (poolFingerprint(pool) === poolFingerprint(prizePool)) return false;

        prizePool = pool;
        if (quiet) return true;

        if (pool.some(item => item.probability > 0)) {
            addLog('📈 站点调整了奖池爆率', 'warning');
        } else {
            opaquePoolWarned = false;
            warnIfPoolOpaque();
        }
        return true;
    }

    /* calibrateBalance 撞上另一次正在跑的校准会直接返回 false。
       多数地方无所谓，但有两处是指着这次结果做决定的：
         · VIP 折算 —— 放弃就等于一百万憨豆不记账
         · 一抽到底的停止判断 —— 放弃就会拿旧余额判定，提前收工
       这两处先等它让开再上。 */
    async function waitForCalibrationSlot(timeoutMs = CONFIG.calibrationWaitMs) {
        const deadline = Date.now() + timeoutMs;
        while (calibrating && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return !calibrating;
    }

    async function calibrateBalance({ quiet = false } = {}) {
        if (calibrating) return false;
        calibrating = true;
        setText('balance-freshness', '校准中...');

        try {
            const snapshot = await fetchServerSnapshot();
            const value = snapshot ? snapshot.balance : null;

            // 爆率和单抽消耗都先换，后面 render() 才会用上新数据
            if (snapshot) {
                adoptPool(snapshot.pool);
                adoptSingleCost(snapshot.cost);
            }

            if (value === null) {
                if (!quiet) addLog('⚠️ 余额校准失败，继续用本地估算', 'warning');
                return false;
            }

            const drift = value - beanBalance;
            beanBalance = value;

            // 校准值必须活过紧接着的 updateBalanceDisplay()。
            // getBeanBalance() 的规则是「DOM 数字变了就采信 DOM」，所以这里要把
            // domBalanceSeen 对齐到 DOM **当前**显示的数：
            //   写成服务端值 → 和 DOM 不等，下一拍就被 DOM 冲掉；
            //   保持不动     → DOM 若真变过，同样会被冲掉。
            // 对齐之后，「DOM 变没变」照常判断，而刚拉回来的权威值不会被过期
            // 的页面数字覆盖（站点从不刷新 .bean-number，它只会越来越旧）。
            const element = document.querySelector('.bean-number');
            const domValue = element ? firstNumber(element.textContent) : null;
            if (domValue !== null) domBalanceSeen = domValue;

            drawsSinceCalibration = 0;
            updateBalanceDisplay();
            render();

            if (!quiet) {
                addLog(Math.abs(drift) >= 1
                    ? `🔄 余额已校准：${fmt(value)}（估算差 ${drift > 0 ? '+' : ''}${fmt(drift)}）`
                    : `🔄 余额已校准：${fmt(value)}`, 'info');
            }
            return true;
        } catch (error) {
            // 校准是挂机路径上的一环，失败只能记一笔继续用估算，不能把循环带崩
            addLog(`⚠️ 余额校准出错：${error?.message || error}`, 'warning');
            return false;
        } finally {
            calibrating = false;
            updateBalanceDisplay();
        }
    }

    /* 抽完一次后更新估算：扣掉本次消耗，中的憨豆当场加回来
       —— 奖池里 type 1001 就是憨豆，所以中奖是真的回血。 */
    function applyDrawToBalance(prize) {
        const won = prize.type === 'beans' ? prize.value : 0;
        beanBalance = Math.max(0, beanBalance - singleCost + won);
        drawsSinceCalibration++;
        updateBalanceDisplay();
    }

    function updateBalanceDisplay() {
        const balance = getBeanBalance();
        const cost = getSingleCost();
        const maxPossible = cost > 0 ? Math.floor(balance / cost) : 0;

        setText('bean-balance', fmt(balance));
        setText('max-possible', fmt(maxPossible));

        if (!calibrating) {
            setText('balance-freshness', drawsSinceCalibration === 0
                ? '已校准'
                : `估算 · ${drawsSinceCalibration} 抽前校准`);
        }

        const startButton = $('start-lottery');
        if (startButton && !running) {
            const insufficient = balance < cost;
            startButton.disabled = insufficient;
            startButton.textContent = insufficient ? '💸 余额不足' : '🎁 开始抽奖';
        }

        return maxPossible;
    }

    /* =========================================================
       日志
    ========================================================= */

    function addLog(message, type = 'info') {
        const container = $('lottery-log');
        if (!container) return;

        container.style.display = 'block';

        const colors = {
            info: '#8a705a',
            error: '#d94a44',
            success: '#4d8a3a',
            warning: '#c97a2e'
        };

        const entry = document.createElement('div');
        entry.style.cssText = `margin-bottom:2px;color:${colors[type] || colors.info};font-weight:500;`;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;

        container.appendChild(entry);
        container.scrollTop = container.scrollHeight;

        while (container.children.length > CONFIG.logLimit) {
            container.removeChild(container.firstChild);
        }
    }

    /* =========================================================
       渲染
    ========================================================= */

    /* 所有类别里被折算成憨豆的总额。目前只有 VIP 会产生，
       写成通用的，以后站点再加别的折算规则不用改这里。 */
    function swappedBeansTotal(stats) {
        return Object.values(stats.prizes)
            .reduce((sum, bucket) => sum + (Number(bucket.swappedBeans) || 0), 0);
    }

    function activeStats() {
        return settings.viewMode === 'total' ? totalStats : currentStats;
    }

    function render() {
        const stats = activeStats();

        setText('draw-count', fmt(stats.draws));
        // 和明细列表口径对齐：只数真中过的，否则导入的数据里
        // 可能带着 count 为 0 的空桶，两处数字对不上
        setText('prize-type-count',
            Object.values(stats.prizes).filter(bucket => bucket.count > 0).length);
        setText('cost-beans', fmt(stats.cost));
        setText('total-beans-won', fmt(stats.gains.beans));

        // 折算来的憨豆不是从憨豆那一格转出来的，单独说一句，
        // 免得有人拿各档位乘开去对「获得憨豆」，发现对不上
        const swapped = swappedBeansTotal(stats);
        const swapNote = $('beans-swap-note');
        if (swapNote) {
            swapNote.textContent = swapped > 0 ? `其中 ${fmt(swapped)} 来自 VIP 折算` : '';
            swapNote.classList.toggle('is-on', swapped > 0);
        }
        setText('total-invites', fmt(stats.gains.invite));
        setText('total-rainbow-days', `${fmt(stats.gains.rainbow)}天`);
        // 显示中奖次数而不是天数：已经是 VIP 的用户中到 VIP 会被折算成憨豆，
        // 天数是 0，那张卡就永远空着 —— 次数才是「中了几次」这件事本身。
        setText('total-vip-count', `${fmt(stats.prizes.vip?.count || 0)}次`);
        setText('total-makeup-cards', fmt(stats.gains.makeup));
        setText('total-upload', `${fmt(stats.gains.upload)}GB`);

        renderProfit(stats);
        renderPrizeDetail(stats);
        renderJackpotLog(stats);
    }

    /* 中奖时刻。跨天的记录光有时分看不出是哪天，所以带上月日。 */
    function whenText(at) {
        if (!at) return '';
        const date = new Date(at);
        const pad = value => String(value).padStart(2, '0');
        return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
            + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /* 大奖名册：几千抽才碰一次的那几笔，单独列出来好回看。
       跟着历史统计一起存，关页面、换会话都还在。 */
    /* 名册是 1.29 才有的，之前每抽只累加次数、没留过时间戳。所以老数据
       里的大奖只知道中过几次，时间是真找不回来了 —— 本地没存。
       与其装作没中过，不如按原始文案数出来，如实标一行。 */
    function legacyJackpotCount(stats) {
        const counted = Object.entries(stats.raw || {})
            .reduce((sum, [text, count]) => (
                isJackpot(parsePrizeText(text)) ? sum + (Number(count) || 0) : sum
            ), 0);
        return Math.max(0, counted - (stats.jackpots || []).length);
    }

    function renderJackpotLog(stats) {
        const list = $('jackpot-log');
        if (!list) return;

        const rows = stats.jackpots || [];
        const legacy = legacyJackpotCount(stats);

        const total = rows.length + legacy;
        setText('jackpot-count', total ? `${fmt(total)} 次` : '还没有');

        // 老数据只数得出次数，没有时间，单独挂一行说明
        const legacyRow = legacy
            ? `<div class="hh-jackpot-legacy">`
              + `👑 更早还中过 ${fmt(legacy)} 次 · 那时候还没开始记时间`
              + `</div>`
            : '';

        if (!rows.length) {
            // 大奖几千抽才碰一次，本次会话空着是常态 —— 与其干说「没有」，
            // 不如指一下历史里其实还存着
            const archived = (totalStats.jackpots || []).length
                + legacyJackpotCount(totalStats);
            const hint = settings.viewMode !== 'total' && archived
                ? `本次还没中过 · 历史里存着 ${fmt(archived)} 次，切到「历史总计」看`
                : '还没中过大奖 · 中了会连时间一起记在这里，换会话也不丢';
            list.innerHTML = legacyRow || `<div class="hh-jackpot-empty">${hint}</div>`;
            return;
        }

        list.innerHTML = rows.map(item =>
            `<div class="hh-jackpot-row">`
            + `<b>👑 ${escapeHtml(item.text)}</b>`
            + `<span class="hh-jackpot-when">${escapeHtml(whenText(item.at))}</span>`
            + `</div>`
        ).join('') + legacyRow;
    }

    /* 憨豆盈亏。奖池里 type 1001 就是憨豆，所以这个数字是实打实的：
       中的憨豆减去消耗，再除以消耗就是实测盈亏率。 */
    function renderProfit(stats) {
        const tone = value => (value > 0 ? '#4d8a3a' : value < 0 ? '#d94a44' : '#a08066');

        const profit = stats.gains.beans - stats.cost;
        const profitElement = $('profit-loss');

        if (profitElement) {
            profitElement.textContent = (profit > 0 ? '+' : '') + fmt(profit);
            profitElement.style.color = tone(profit);
        }

        const rateElement = $('profit-rate');
        if (!rateElement) return;

        if (stats.cost <= 0) {
            rateElement.textContent = '-';
            rateElement.style.color = '#a08066';
            return;
        }

        const rate = (profit / stats.cost) * 100;
        rateElement.textContent = `${rate > 0 ? '+' : ''}${rate.toFixed(1)}%`;
        rateElement.style.color = tone(rate);
    }

    /* 分奖项明细：一级按类别聚合，二级展开具体档位 */
    function renderPrizeDetail(stats) {
        const list = $('detail-list');
        if (!list) return;

        const rows = Object.entries(stats.prizes)
            .filter(([, bucket]) => bucket.count > 0)
            .sort((a, b) => b[1].count - a[1].count || PRIZE_ORDER.indexOf(a[0]) - PRIZE_ORDER.indexOf(b[0]));

        const totalCount = rows.reduce((sum, [, bucket]) => sum + bucket.count, 0);
        const official = officialRates();

        setText('detail-summary', `共 ${fmt(totalCount)} 抽 · ${rows.length} 种`);

        // 重新渲染前记住哪些类别是展开的，避免抽奖刷新时折叠状态丢失
        const openTypes = new Set(
            Array.from(list.querySelectorAll('.hh-row.is-open')).map(row => row.dataset.type)
        );

        list.innerHTML = '';

        if (!totalCount) {
            const empty = document.createElement('div');
            empty.className = 'hh-detail-empty';
            empty.textContent = '暂无奖品数据，开始抽奖后这里会显示每个奖项的中奖次数';
            list.appendChild(empty);
            return;
        }

        rows.forEach(([type, bucket]) => {
            const meta = PRIZE_META[type] || PRIZE_META.unknown;
            const percentage = ((bucket.count / totalCount) * 100).toFixed(1);

            const row = document.createElement('div');
            row.className = 'hh-row';
            row.dataset.type = type;
            if (openTypes.has(type) || settings.detailOpen === 'all') {
                row.classList.add('is-open');
            }

            const tiers = Object.entries(bucket.tiers)
                .sort((a, b) => b[1] - a[1])
                .map(([label, count]) => {
                    // 实测占比一直都要显示。站点撤掉爆率后是没得「对比」，
                    // 不是没得「算」—— 之前把整行都跟着官方爆率一起藏了。
                    const tierOfficial = official.byTier[`${type}|${label}`];
                    const measured = `实测 ${((count / totalCount) * 100).toFixed(2)}%`;
                    const rateLine = `<span class="hh-tier-rate">${measured}${
                        tierOfficial === undefined ? '' : ` · 官方 ${(tierOfficial * 100).toFixed(2)}%`
                    }</span>`;
                    return `
                    <div class="hh-tier">
                        <span class="hh-tier-name">${escapeHtml(label)}</span>
                        ${rateLine}
                        <span class="hh-tier-count">${fmt(count)} 次</span>
                    </div>
                `;
                })
                .join('');

            // 累计可能有两行：本类别自己的单位一行，被折算成憨豆的另起一行。
            // VIP 被换成憨豆时天数和憨豆不是一个单位，混在一行里没法看。
            const sums = [];
            if (bucket.value > 0) {
                sums.push(`累计 ${fmt(bucket.value)}${meta.unit ? ' ' + meta.unit : ''}`);
            }
            if (bucket.swappedBeans > 0) {
                sums.push(`另折算 ${fmt(bucket.swappedBeans)} 憨豆`);
            }
            const sumLine = sums.map(text => `<div class="hh-row-sum">${text}</div>`).join('');

            // 官方爆率读不到时（页面结构变了 / 非抽奖页）整块降级，只显示实测
            const typeOfficial = official.byType[type];
            const officialCell = typeOfficial === undefined
                ? ''
                : `<span class="hh-row-official">官方 ${(typeOfficial * 100).toFixed(1)}%</span>`;
            const officialMark = typeOfficial === undefined
                ? ''
                : `<div class="hh-row-bar-mark" style="left:calc(${Math.min(100, typeOfficial * 100).toFixed(1)}% - 1px)" title="官方爆率 ${(typeOfficial * 100).toFixed(2)}%"></div>`;

            row.innerHTML = `
                <div class="hh-row-head">
                    <span class="hh-row-caret">▶</span>
                    <span class="hh-row-icon">${meta.icon}</span>
                    <span class="hh-row-name">${escapeHtml(meta.name)}</span>
                    <span class="hh-row-count">${fmt(bucket.count)} 次</span>
                    <span class="hh-row-pct">${percentage}%</span>
                    ${officialCell}
                </div>
                <div class="hh-row-bar">
                    <div class="hh-row-bar-fill" style="width:${percentage}%"></div>
                    ${officialMark}
                </div>
                ${sumLine}
                <div class="hh-tiers">${tiers}</div>
            `;

            row.querySelector('.hh-row-head').addEventListener('click', () => {
                row.classList.toggle('is-open');
            });

            list.appendChild(row);
        });
    }

    /* =========================================================
       中奖动画
    ========================================================= */

    function showWinAnimation(prizeText) {
        // 切到别的标签页时没人看，省掉每次 20+ 个粒子节点的创建与回收
        if (document.hidden) return;

        const old = document.querySelector('.hh-win-overlay');
        if (old) old.remove();

        const popup = document.createElement('div');
        popup.className = 'hh-win-overlay';
        popup.innerHTML = `
            <div class="hh-win-title">🎉 恭喜中奖！</div>
            <div class="hh-win-prize">🎁 ${escapeHtml(prizeText)}</div>
        `;

        document.body.appendChild(popup);
        createConfetti();

        setTimeout(() => popup.remove(), 2000);
    }

    /* 大奖专用全屏庆祝：整屏压暗 + 金色光爆 + 奖品名放大登场 + 双向礼花。
       和普通中奖动画一样受「中奖动画」开关和 document.hidden 控制，
       prefers-reduced-motion 下由 CSS 收敛成静态显示。 */
    function showJackpotAnimation(prizeText, willStop) {
        if (document.hidden) return;

        document.querySelectorAll('.hh-jackpot-overlay').forEach(node => node.remove());

        const seconds = Math.round(CONFIG.jackpotHoldMs / 1000);
        const overlay = document.createElement('div');
        overlay.className = 'hh-jackpot-overlay';
        overlay.innerHTML = `
            <div class="hh-jackpot-rays"></div>
            <div class="hh-jackpot-card">
                <div class="hh-jackpot-kicker">✨ 大 奖 ✨</div>
                <div class="hh-jackpot-prize">${escapeHtml(prizeText)}</div>
                <div class="hh-jackpot-sub">这一注值得截图</div>
                <div class="hh-jackpot-when">${escapeHtml(whenText(Date.now()))}</div>
                <button type="button" class="hh-jackpot-close">
                    截好了，关掉（<span class="hh-jackpot-left">${seconds}</span>s）
                </button>
                <div class="hh-jackpot-hint">点任意处或按 Esc 也能关 · ${willStop
                    ? '已按设置停止抽奖，慢慢看'
                    : '抽奖没停，在后台照跑'}</div>
            </div>
        `;

        document.body.appendChild(overlay);
        createFireworks();

        // 一个出口收口所有关闭方式，免得计时器和点击各关各的、
        // 或者关过之后计时器又来动一次已经没了的节点
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            clearInterval(ticking);
            document.removeEventListener('keydown', onKey);
            overlay.classList.add('is-out');
            setTimeout(() => overlay.remove(), 600);
        };

        const onKey = event => {
            if (event.key === 'Escape') close();
        };

        const left = overlay.querySelector('.hh-jackpot-left');
        let remain = seconds;
        const ticking = setInterval(() => {
            remain -= 1;
            if (left) left.textContent = Math.max(0, remain);
            if (remain <= 0) close();
        }, 1000);

        overlay.addEventListener('click', close);
        document.addEventListener('keydown', onKey);
    }

    /* 从屏幕左右下角各打一束，比普通粒子更密、更慢、带重力感 */
    function createFireworks() {
        const symbols = ['🎆', '🎇', '⭐', '✨', '🌟', '💰', '👑', '🎉'];
        const origins = [
            { x: 0.12, y: 0.92 },
            { x: 0.88, y: 0.92 },
            { x: 0.5, y: 0.15 }
        ];

        origins.forEach((origin, index) => {
            for (let i = 0; i < 26; i++) {
                const item = document.createElement('div');
                item.className = 'hh-firework';
                item.textContent = symbols[Math.floor(Math.random() * symbols.length)];

                const angle = Math.random() * Math.PI * 2;
                const distance = 180 + Math.random() * 420;

                item.style.cssText = `
                    left: ${window.innerWidth * origin.x}px;
                    top: ${window.innerHeight * origin.y}px;
                    font-size: ${14 + Math.random() * 16}px;
                    --tx: ${Math.cos(angle) * distance}px;
                    --ty: ${Math.sin(angle) * distance - 120}px;
                    --rot: ${(Math.random() - .5) * 1080}deg;
                    animation-delay: ${index * .18 + Math.random() * .3}s;
                `;

                document.body.appendChild(item);
                setTimeout(() => item.remove(), 3600);
            }
        });
    }

    function createConfetti() {
        const symbols = ['⭐', '✨', '🎉', '🎈', '🎁', '🔴', '🟡', '🌟'];

        for (let i = 0; i < 22; i++) {
            const item = document.createElement('div');
            item.className = 'hh-confetti';
            item.textContent = symbols[Math.floor(Math.random() * symbols.length)];

            item.style.cssText = `
                position: fixed;
                left: ${window.innerWidth / 2}px;
                top: ${window.innerHeight / 2}px;
                z-index: 2147483649;
                pointer-events: none;
                font-size: 16px;
                animation: hhConfetti 1.4s ease-out forwards;
                --tx: ${(Math.random() - .5) * 420}px;
                --ty: ${(Math.random() - .5) * 360}px;
                --rot: ${(Math.random() - .5) * 900}deg;
                animation-delay: ${Math.random() * .12}s;
            `;

            document.body.appendChild(item);
            setTimeout(() => item.remove(), 1700);
        }
    }

    /* =========================================================
       抽奖接口
    ========================================================= */

    async function performLottery() {
        try {
            const response = await fetch(LOTTERY_API, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'accept': '*/*',
                    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'referer': LOTTERY_PAGE,
                    'x-requested-with': 'XMLHttpRequest',
                    // 站点自己用的是 jQuery.post，带 form 类型的 Content-Type，
                    // 这里对齐，免得请求特征和正常点击不一样
                    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
                },
                body: ''
            });

            const resultText = await response.text();

            let parsed = null;
            try {
                parsed = JSON.parse(resultText);
            } catch (error) {
                // 非 JSON 响应，交给上层按失败处理
            }

            return { success: response.ok, status: response.status, data: resultText, parsed };
        } catch (error) {
            return { success: false, status: 0, error: error.message, data: '', parsed: null };
        }
    }

    /* =========================================================
       抽奖循环

       改为 await 完成后再排下一次的串行循环。
       以前用 setInterval 调 async 函数，请求一旦慢过间隔就会并发发起，
       既会重复扣豆，也会触发站点的重复点击风控；
       同时 setInterval 的周期是创建时固定的，退避后间隔再也降不回来。
    ========================================================= */

    function baseIntervalMs() {
        const seconds = normalizeInterval($('lottery-interval')?.value, settings.interval);
        return Math.round(seconds * 1000);
    }

    /* 说多久就是多久 —— 以前会在设定值上下浮动 15%，
       填 3 秒实际可能跑成 2.55 或 3.45 秒，对不上账。 */
    /* 计划中的这一轮抽奖间隔（从发出上一枪算起）。

       站点的冷却就是上一抽的 duration，所以真正的下限由它说了算；
       手填的间隔只作为「再慢也不低于这个数」的底。 */
    function plannedGapMs() {
        // 自适应模式下节奏完全由站点定，手填的间隔一点都不掺和 ——
        // 拿它当下限的话，站点只要转得比它快，那点便宜就白白丢了
        if (settings.followDuration) {
            const base = lastDurationMs || CONFIG.blindGapMs;
            return Math.max(500, base + settings.bufferMs);
        }
        return Math.max(500, Math.round(dynamicInterval));
    }

    function nextDelayMs() {
        // 被限流后的快速补枪：被拒不会重置服务端计时，等满一个周期纯属浪费
        if (quickRetryMs > 0) {
            const wait = quickRetryMs;
            quickRetryMs = 0;
            return wait;
        }

        const gap = plannedGapMs();
        if (settings.followDuration && lastDrawSentAt) {
            // 计时起点是「发出请求」那一刻 —— 响应传输和本地结算花掉的
            // 时间已经在冷却里数过了，从间隔里扣掉
            const elapsed = Date.now() - lastDrawSentAt;
            return Math.max(250, gap - elapsed);
        }
        return gap;
    }

    function setDurationInfo() {
        const info = $('duration-info');
        if (!info) return;
        info.textContent = lastDurationMs
            ? `上一抽转盘 ${intervalText(lastDurationMs / 1000)}s · 本次等 ${intervalText(plannedGapMs() / 1000)}s`
            : '等第一抽后自动调节';
    }

    function setCurrentIntervalDisplay() {
        setText('current-interval', intervalText(plannedGapMs() / 1000));
    }

    async function runSingleDraw(maxCount) {
        const roundCount = currentStats.draws - roundStartDraws;
        // 一抽到底没有「总共几次」可言，报余额更有意义
        addLog(settings.drainMode
            ? `🎲 第 ${roundCount + 1} 次抽奖 · 余额 ${fmt(beanBalance)}`
            : `🎲 第 ${roundCount + 1}/${maxCount} 次抽奖`, 'info');

        // 冷却从服务端受理这一枪就开始计时，把发出时刻记下来当起点
        lastDrawSentAt = Date.now();

        const result = await performLottery();
        if (!running) return;

        if (!result.success || !result.parsed) {
            errorStreak++;
            quickRetryMs = stepBackoffMs(errorStreak, CONFIG.errorRetryMs);
            addLog(`❌ 请求失败：${result.error || result.status || '未知错误'}`
                + ` · ${intervalText(quickRetryMs / 1000)} 秒后再试`, 'error');
            noteStuck(errorStreak, '请求失败');
            return;
        }

        const data = result.parsed;

        if (data.ret === 0) {
            errorStreak = 0;
            rateLimitStreak = 0;
            dynamicInterval = baseIntervalMs();
            setCurrentIntervalDisplay();

            // 站点把下一抽的冷却写在这儿了 —— 转盘转多久就得等多久
            const spin = Number(data.data?.duration);
            lastDurationMs = Number.isFinite(spin) && spin > 0 && spin <= 300000 ? spin : 0;
            setDurationInfo();

            const prizeText = decodeUnicode(data.data?.prize_text || '未知奖品');
            const recordId = data.data?.winning_record_id || '';
            const prize = parsePrizeText(prizeText);

            addLog(`🎉 抽中：${prizeText}${recordId ? ` · ID ${recordId}` : ''}`, 'success');
            recordDraw(prizeText);
            applyDrawToBalance(prize);

            // VIP 那一注可能被站点换成了憨豆，当场核一下
            if (prize.type === 'vip') await reconcileVipPrize(prize);
            if (!running) return;

            if (pendingJackpotStop) {
                const text = pendingJackpotStop;
                pendingJackpotStop = null;

                /* 收工前拿一次权威余额 —— 开这个功能本来就是为了停在中奖
                   那一刻对账，面板上摆个本地估算说不过去。
                   VIP 那一注刚才折算核对时已经校准过，这里就跳过了。 */
                if (drawsSinceCalibration > 0) {
                    await waitForCalibrationSlot();
                    await calibrateBalance({ quiet: true });
                }

                stopLottery(`🏆 抽到大奖，已按设置停止 · ${text}`);
                return;
            }

            if (drawsSinceCalibration >= CONFIG.balanceSyncEveryDraws) {
                await calibrateBalance({ quiet: true });
                await autoCleanMail();
            }
            return;
        }

        const msg = decodeUnicode(data.msg || '未知错误');

        if (msg.includes('重复点击') || msg.includes('请稍后') || msg.includes('频繁')) {
            rateLimitStreak++;
            if (settings.followDuration) {
                // 被拒不重置服务端计时、也不扣憨豆，快速补枪即可。
                // 冷却剩多久不知道时（开抽前刚手动转过一把）起步放慢一点。
                // 一直被拒就按阶梯往上抬，不设次数上限 —— 站点在限流，
                // 等下去总能过，停了反而白白空过一整夜。
                const base = lastDurationMs ? CONFIG.rateLimitRetryMs : CONFIG.blindRetryMs;
                quickRetryMs = stepBackoffMs(rateLimitStreak, base);
                addLog(lastDurationMs
                    ? `⏳ ${msg}（上一抽转盘 ${intervalText(lastDurationMs / 1000)} 秒，没等够 · ${quickRetryMs}ms 后补一枪）`
                    : `⏳ ${msg}（冷却剩多久未知，${quickRetryMs}ms 后再试）`, 'warning');
            } else {
                quickRetryMs = stepBackoffMs(rateLimitStreak, CONFIG.rateLimitRetryMs);
                addLog(`⏳ ${msg} · ${intervalText(quickRetryMs / 1000)} 秒后再试`, 'warning');
                if (rateLimitStreak >= CONFIG.backoffAfterErrors) {
                    dynamicInterval = Math.min(dynamicInterval * CONFIG.backoffFactor, CONFIG.maxBackoffMs);
                    setCurrentIntervalDisplay();
                }
            }

            noteStuck(rateLimitStreak, '被限流');
            return;
        }

        if (msg.includes('次数') || msg.includes('用完') || msg.includes('余额不足') || msg.includes('憨豆不足')) {
            addLog(`❌ ${msg}，停止抽奖`, 'error');
            stopLottery('🛑 抽奖已停止');
            return;
        }

        errorStreak++;
        quickRetryMs = stepBackoffMs(errorStreak, CONFIG.errorRetryMs);
        addLog(`❌ ${msg} · ${intervalText(quickRetryMs / 1000)} 秒后再试`, 'error');
        noteStuck(errorStreak, '接口报错');
    }

    /* 连续失败第 streak 次该等多久。每 retryStepEvery 次抬一档：
       基数 300 时是 300 300 300 · 450 450 450 · 675 …，封顶 maxRetryMs。 */
    function stepBackoffMs(streak, baseMs) {
        const step = Math.floor(Math.max(0, streak - 1) / CONFIG.retryStepEvery);
        return Math.min(
            CONFIG.maxRetryMs,
            Math.round(baseMs * Math.pow(CONFIG.retryStepFactor, step))
        );
    }

    /* 一直卡着不动时隔一阵子说一声，让人知道它还在转、卡在哪 ——
       但不停机，无人值守的时候停了就再也起不来了。 */
    function noteStuck(streak, what) {
        if (streak > 0 && streak % CONFIG.stuckWarnEvery === 0) {
            addLog(`⚠️ ${what}已经连续 ${streak} 次 · 仍在重试，`
                + `当前每 ${intervalText(stepBackoffMs(streak, CONFIG.errorRetryMs) / 1000)} 秒探一次`, 'warning');
        }
    }

    /* 一抽到底：抽到「再抽一次就会跌破保留线」为止，不设次数上限。
       余额用的是本地估算，所以真要停之前先回服务端校准一次，
       免得因为估算漂移多抽或少抽。 */
    async function shouldStopForReserve() {
        const reserve = Math.max(0, settings.reserveBeans);
        if (beanBalance - singleCost >= reserve) return false;

        // 估算说该停了，但可能是漂移造成的 —— 拿权威值再确认一遍。
        // 校准被别的调用占着时先等一下，直接放弃的话会拿旧余额判定、提前收工。
        if (drawsSinceCalibration > 0) {
            await waitForCalibrationSlot();
            await calibrateBalance({ quiet: true });
            if (beanBalance - singleCost >= reserve) return false;
        }
        return true;
    }

    async function lotteryLoop(maxCount) {
        while (running) {
            // 看门狗的心跳。被冻住时这个值会停住，切回前台一比就知道
            lastTickAt = Date.now();
            const roundCount = currentStats.draws - roundStartDraws;

            if (settings.drainMode) {
                if (await shouldStopForReserve()) {
                    stopLottery(`🏁 一抽到底完成 · 保留 ${fmt(Math.max(0, settings.reserveBeans))} 憨豆`);
                    return;
                }
            } else if (roundCount >= maxCount) {
                stopLottery('🎯 本轮达到最大抽奖次数');
                return;
            }

            if (!running) return;

            await runSingleDraw(maxCount);
            if (!running) return;

            await sleep(nextDelayMs());
        }
    }

    function startLottery() {
        if (running) return;

        const interval = normalizeInterval($('lottery-interval')?.value, settings.interval);
        const maxCount = Math.max(1, parseInt($('max-lottery-count')?.value, 10) || settings.maxCount);

        if ($('lottery-interval')) $('lottery-interval').value = intervalText(interval);
        if ($('max-lottery-count')) $('max-lottery-count').value = maxCount;

        settings.interval = interval;
        settings.maxCount = maxCount;
        saveSettings();

        const reserve = Math.max(0, parseInt($('reserve-beans')?.value, 10) || 0);
        if ($('reserve-beans')) $('reserve-beans').value = reserve;
        settings.reserveBeans = reserve;
        saveSettings();

        if (updateBalanceDisplay() <= 0) {
            addLog('💸 憨豆不足，无法开始抽奖', 'error');
            return;
        }

        if (settings.drainMode && beanBalance - singleCost < reserve) {
            addLog(`💸 余额已在保留线（${fmt(reserve)}）之下，无需抽奖`, 'warning');
            return;
        }

        lastDurationMs = 0;
        lastDrawSentAt = 0;
        quickRetryMs = 0;
        pendingJackpotStop = null;
        lastTickAt = Date.now();
        setDurationInfo();
        // 趁着点击这个手势把保活挂起来，晚了就要被 autoplay 策略拦
        startKeepAlive();
        dynamicInterval = Math.round(interval * 1000);
        errorStreak = 0;
        rateLimitStreak = 0;
        mailCleaned = 0;
        roundStartDraws = currentStats.draws;
        running = true;

        setCurrentIntervalDisplay();

        const status = $('lottery-status');
        if (status) {
            const pace = settings.followDuration ? '自适应' : `${intervalText(interval)}s`;
            status.textContent = settings.drainMode ? `一抽到底 · ${pace}` : `运行中 · ${pace}`;
            status.style.color = '#4d8a3a';
        }

        const startButton = $('start-lottery');
        if (startButton) {
            startButton.disabled = true;
            startButton.textContent = '🎲 抽奖进行中...';
        }
        const stopButton = $('stop-lottery');
        if (stopButton) stopButton.disabled = false;

        const paceText = settings.followDuration
            ? '间隔自适应'
            : `间隔 ${intervalText(interval)} 秒`;
        addLog(settings.drainMode
            ? `🔥 一抽到底 · 保留 ${fmt(reserve)} 憨豆 · ${paceText}`
            : `🚀 开始抽奖 · ${maxCount} 次 · ${paceText}`, 'success');

        // 循环里任何一处抛异常都不能静默吞掉 —— 不接这个 catch 的话
        // running 会一直卡在 true，面板显示「抽奖进行中」但其实早停了
        lotteryLoop(maxCount).catch(error => {
            addLog(`❌ 抽奖循环异常：${error?.message || error}`, 'error');
            stopLottery('🛑 内部异常，已停止');
        });
    }

    function stopLottery(message = '🛑 抽奖已停止') {
        if (!running) return;

        running = false;
        cancelSleep();
        stopKeepAlive();

        const status = $('lottery-status');
        if (status) {
            status.textContent = '已停止';
            status.style.color = '#d94a44';
        }

        const stopButton = $('stop-lottery');
        if (stopButton) stopButton.disabled = true;

        addLog(message, 'warning');
        updateBalanceDisplay();
    }

    /* =========================================================
       数据操作
    ========================================================= */

    function resetCurrentData() {
        if (running) {
            addLog('⚠️ 请先停止自动抽奖', 'warning');
            return;
        }
        if (!confirm('确定要重置本次会话数据吗？（历史统计不受影响）')) return;

        currentStats = emptyStats();
        roundStartDraws = 0;
        render();
        addLog('✅ 本次数据已重置', 'success');
    }

    function clearTotalData() {
        if (!confirm('确定要清空全部历史统计吗？此操作无法撤销！')) return;

        localStorage.removeItem(STATS_KEY);
        localStorage.removeItem(LEGACY_STATS_KEY);
        totalStats = emptyStats();
        render();
        addLog('🗑 历史统计已清空', 'success');
    }

    /* 导出分奖项明细，方便自己拉表算真实爆率 */
    function exportStats() {
        const stats = activeStats();
        const scope = settings.viewMode === 'total' ? '历史总计' : '本次数据';

        const rows = Object.entries(stats.prizes)
            .filter(([, bucket]) => bucket.count > 0)
            .sort((a, b) => b[1].count - a[1].count || PRIZE_ORDER.indexOf(a[0]) - PRIZE_ORDER.indexOf(b[0]));

        const totalCount = rows.reduce((sum, [, bucket]) => sum + bucket.count, 0);

        if (!totalCount) {
            addLog('⚠️ 暂无数据可导出', 'warning');
            return;
        }

        const escapeCsv = value => `"${String(value).replace(/"/g, '""')}"`;
        const lines = ['类别,档位,次数,占比'];

        rows.forEach(([type, bucket]) => {
            const meta = PRIZE_META[type] || PRIZE_META.unknown;
            lines.push([
                escapeCsv(meta.name),
                escapeCsv('（小计）'),
                bucket.count,
                escapeCsv(`${((bucket.count / totalCount) * 100).toFixed(2)}%`)
            ].join(','));

            Object.entries(bucket.tiers)
                .sort((a, b) => b[1] - a[1])
                .forEach(([label, count]) => {
                    lines.push([
                        escapeCsv(meta.name),
                        escapeCsv(label),
                        count,
                        escapeCsv(`${((count / totalCount) * 100).toFixed(2)}%`)
                    ].join(','));
                });
        });

        lines.push('');
        lines.push([escapeCsv('抽奖次数'), '', stats.draws, ''].join(','));
        lines.push([escapeCsv('累计消耗憨豆'), '', stats.cost, ''].join(','));
        lines.push([escapeCsv('获得憨豆'), '', stats.gains.beans, ''].join(','));

        // 面板上有这行说明，CSV 里也得有 —— 折算来的憨豆不在憨豆档位里，
        // 少了这一行，拿各档位乘开去对「获得憨豆」会差出一大截
        const swapped = swappedBeansTotal(stats);
        if (swapped > 0) {
            lines.push([escapeCsv('其中来自 VIP 折算'), '', swapped, ''].join(','));
        }

        lines.push([escapeCsv('憨豆盈亏'), '', stats.gains.beans - stats.cost, ''].join(','));

        // 带 BOM，Excel 打开中文不乱码
        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        downloadBlob(blob, `hhclub-lottery-${settings.viewMode}-${stamp}.csv`);

        addLog(`📤 已导出${scope}明细`, 'success');
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');

        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /* 完整备份。和 CSV 不同：CSV 是给表格看的，这份是能原样导回来的。 */
    function backupStats() {
        // 一抽都没抽过时 loadStats() 返回的是没落过盘的空统计，编号也是空的。
        // 在这儿补上，这份备份才带得走记录线
        const total = stampOrigin(loadStats());
        const payload = {
            kind: 'hhclub-lottery-backup',
            version: 4,
            exportedAt: new Date().toISOString(),
            /* 这两个编号是给「重复导入」把关用的：originId 认记录线，
               exportId 认这一个文件。老备份没有也照样能导，只是认不出重复。 */
            originId: total.originId,
            exportId: randomId(),
            current: currentStats,
            total
        };

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

        // 文件名带上抽数，一堆备份摆在一起时不用挨个打开才知道谁新
        downloadBlob(blob, `hhclub-lottery-backup-${stamp}-${total.draws}抽.json`);
        addLog(`💾 已导出备份 · ${fmt(total.draws)} 抽`, 'success');
    }

    /* 两份统计相加。导入时选「合并」走这里，两边结构同构所以能逐项累加。 */
    function mergeStats(base, extra) {
        const result = normalizeStats(base);
        const other = normalizeStats(extra);

        result.draws += other.draws;
        result.cost += other.cost;
        Object.keys(result.gains).forEach(key => {
            result.gains[key] += other.gains[key] || 0;
        });

        Object.entries(other.prizes).forEach(([type, bucket]) => {
            const target = ensureBucket(result, type);
            target.count += bucket.count;
            target.value += bucket.value;

            const swapped = Number(bucket.swappedBeans) || 0;
            if (swapped) target.swappedBeans = (target.swappedBeans || 0) + swapped;
            Object.entries(bucket.tiers).forEach(([label, count]) => {
                target.tiers[label] = (target.tiers[label] || 0) + count;
            });
        });

        Object.entries(other.raw).forEach(([text, count]) => {
            result.raw[text] = (result.raw[text] || 0) + count;
        });

        // 名册按时间倒序合并；同一条记录（时刻 + 文案都一样）只留一份，
        // 免得同一份备份导入两次就多出一堆重影
        const seen = new Set();
        result.jackpots = [...result.jackpots, ...other.jackpots]
            .filter(item => {
                const key = `${item.at}|${item.text}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((a, b) => b.at - a.at)
            .slice(0, CONFIG.jackpotLogLimit);

        /* 台账要一起并过来：合并之后这份统计就「含有」对方的历史了。
           哪天对方那台机器把这份导回去，靠台账就能认出转了一圈的自己。 */
        const ledger = new Map();
        [...result.imports, ...other.imports].forEach(item => {
            ledger.set(`${item.exportId || ''}|${item.originId || ''}`, item);
        });
        // 台账满了要扔的是最旧的那批，所以先按时间排一遍再截
        result.imports = [...ledger.values()]
            .sort((a, b) => (a.at || 0) - (b.at || 0))
            .slice(-CONFIG.importLedgerLimit);

        const firsts = [base?.firstAt, extra?.firstAt].filter(Boolean);
        if (firsts.length) result.firstAt = Math.min(...firsts);
        result.lastAt = Math.max(base?.lastAt || 0, extra?.lastAt || 0) || null;

        return result;
    }

    /* 这份统计里含有哪些记录线：自己的，加上历次并进来的。
       两份统计的记录线一旦有交集，就说明它们共享过历史。 */
    function lineageOf(stats) {
        const ids = new Set();
        if (stats?.originId) ids.add(stats.originId);
        (stats?.imports || []).forEach(item => {
            if (item.originId) ids.add(item.originId);
        });
        return ids;
    }

    /* 统计存的是累加值，没有逐抽的流水，所以合并没法真去重 —— 重叠的部分
       一定会被算两遍。既然改不了这一点，那就在按下去之前认出来、说清楚。

       返回 null 表示没查出问题。 */
    function detectOverlap(existing, incoming) {
        const seen = (existing.imports || []).find(
            item => incoming.exportId && item.exportId === incoming.exportId
        );
        if (seen) {
            const when = seen.at ? new Date(seen.at).toLocaleString('zh-CN') : '之前';
            return {
                sure: true,
                title: '这个文件已经合并过一次了',
                detail: `${when} 并进来过同一份备份。再合一次，里面每一抽都会被算两遍。`
            };
        }

        const mine = lineageOf(existing);
        if ([...lineageOf(incoming)].some(id => mine.has(id))) {
            return {
                sure: true,
                title: '两份记录同源',
                detail: '这份备份和当前历史出自同一条记录线（同一台设备，'
                    + '或者两边互相导过），重叠的部分合并后会被算两遍。'
            };
        }

        /* 老备份没有编号，只能拿大奖时刻对表。时刻精确到毫秒，
           同一毫秒中同一个奖不可能是巧合。 */
        const stamps = new Set((existing.jackpots || []).map(item => `${item.at}|${item.text}`));
        const hit = (incoming.jackpots || []).filter(item => stamps.has(`${item.at}|${item.text}`));
        if (hit.length) {
            return {
                sure: true,
                title: `有 ${hit.length} 条大奖记录跟当前历史完全重合`,
                detail: '同一毫秒中同一个奖不会是巧合，这两份记录是重叠的。'
            };
        }

        // 再退一步：时间区间整个被罩住，抽数也不更多，多半是旧快照
        if (incoming.draws > 0 && existing.draws >= incoming.draws
            && incoming.firstAt && incoming.lastAt && existing.firstAt && existing.lastAt
            && incoming.firstAt >= existing.firstAt && incoming.lastAt <= existing.lastAt) {
            /* 这一条只是「看着像」，不是证据 —— 两个人在同一段时间里各刷各的，
               抽得少的那份区间自然被罩住。所以 sure 留 false：提醒一句，
               但不去动推荐项，免得把正常的跨设备合并劝退了。 */
            return {
                sure: false,
                title: '看着像是同一批记录的旧快照',
                detail: '这份备份的时间区间整个落在当前历史里，抽数也不比现在多。'
                    + '要是确实来自另一个号 / 另一个人，那就是巧合，合并没问题。'
            };
        }
        return null;
    }

    /* confirm() 只有两个出口，塞不下「合并 / 覆盖 / 取消」三种意图 ——
       之前用「取消 = 合并」，既反直觉又没了真正的退出路径。改成自己弹一个。
       合并是主路径：不同设备的记录本来就不重合。

       查出重叠时不堵死合并 —— 万一是误判，用户仍该说了算 —— 但把推荐项
       换掉：新快照推「覆盖」（同源的新快照本来就是旧的超集，覆盖才是对的），
       旧快照推「取消」（当前历史已经含着它了，什么都不用做）。 */
    function askImportMode(drawCount, currentCount, overlap) {
        return new Promise(resolve => {
            // 只有拿得出证据的重叠才动推荐项；「看着像」的那种提醒一句就够了
            const proven = !!overlap?.sure;
            const recommend = !proven ? 'merge'
                : (drawCount > currentCount ? 'replace' : 'cancel');
            const cls = mode => `hh-modal-btn${mode === recommend ? ' hh-modal-primary' : ''}`;

            const overlay = document.createElement('div');
            overlay.className = 'hh-modal-overlay';
            overlay.innerHTML = `
                <div class="hh-modal">
                    <div class="hh-modal-title">📥 导入备份</div>
                    ${overlap ? `
                    <div class="hh-modal-warn${proven ? '' : ' is-soft'}">
                        <b>${proven ? '⚠️' : 'ℹ️'} ${overlap.title}</b>
                        ${overlap.detail}
                    </div>` : ''}
                    <div class="hh-modal-text">
                        备份里有 <b>${fmt(drawCount)}</b> 抽记录，<br>
                        当前历史统计有 <b>${fmt(currentCount)}</b> 抽。
                    </div>
                    <button class="${cls('merge')}" data-mode="merge">
                        合并 · 共 ${fmt(drawCount + currentCount)} 抽
                        <span>${proven
                            ? '⚠️ 重叠的那部分会被算两遍，确认不是重复导入再选'
                            : (overlap
                                ? '确认这两份记录不重叠再合'
                                : '换设备用这个，两边记录相加')}</span>
                    </button>
                    <button class="${cls('replace')}" data-mode="replace">
                        覆盖 · 只留 ${fmt(drawCount)} 抽
                        <span>${proven && drawCount > currentCount
                            ? '同源的新快照选这个，不会重复计算'
                            : '丢掉当前历史，只保留备份里的'}</span>
                    </button>
                    <button class="${recommend === 'cancel'
                        ? 'hh-modal-btn hh-modal-primary' : 'hh-modal-btn hh-modal-ghost'}"
                        data-mode="cancel">取消${recommend === 'cancel'
                            ? '<span>重叠的部分已经在当前历史里了</span>' : ''}</button>
                </div>
            `;

            const done = mode => {
                overlay.remove();
                document.removeEventListener('keydown', onKey);
                resolve(mode);
            };
            const onKey = event => {
                if (event.key === 'Escape') done('cancel');
            };

            overlay.addEventListener('click', event => {
                const button = event.target.closest('[data-mode]');
                if (button) return done(button.dataset.mode);
                if (event.target === overlay) done('cancel');
            });
            document.addEventListener('keydown', onKey);

            document.body.appendChild(overlay);
        });
    }

    function importStats() {
        if (running) {
            addLog('⚠️ 请先停止自动抽奖', 'warning');
            return;
        }

        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = 'application/json,.json';

        picker.addEventListener('change', async () => {
            const file = picker.files?.[0];
            if (!file) return;

            let payload;
            try {
                payload = JSON.parse(await file.text());
            } catch (error) {
                addLog('❌ 备份文件不是合法 JSON', 'error');
                return;
            }

            // 备份文件和裸的统计对象都收
            const incoming = payload?.total || payload?.current || payload;
            if (!incoming || typeof incoming !== 'object' || incoming.draws === undefined) {
                addLog('❌ 认不出这个文件的格式', 'error');
                return;
            }

            const parsed = normalizeStats(incoming);
            // 编号在备份文件的外层，裸统计对象里也认
            parsed.originId = parsed.originId
                || (typeof payload?.originId === 'string' ? payload.originId : null);
            const exportId = typeof payload?.exportId === 'string' ? payload.exportId : null;

            const existing = loadStats();
            const overlap = detectOverlap(existing, { ...parsed, exportId });
            if (overlap) addLog(`⚠️ ${overlap.title}`, 'warning');

            const mode = await askImportMode(parsed.draws, existing.draws, overlap);

            if (mode === 'cancel') {
                addLog('📥 已取消导入', 'info');
                return;
            }

            const merged = mode === 'replace' ? parsed : mergeStats(existing, parsed);
            /* 覆盖之后这台机器就是那条记录线的延续，血脉跟着备份走；
               合并则留着自己的。两种情况都要把这次导入记进台账，
               下次同一个文件再进来就认得出。 */
            if (!merged.originId) merged.originId = randomId();
            merged.imports = [...merged.imports, {
                exportId,
                originId: parsed.originId,
                draws: parsed.draws,
                at: Date.now()
            }].slice(-CONFIG.importLedgerLimit);

            saveStats(merged);
            totalStats = merged;

            settings.viewMode = 'total';
            saveSettings();
            const viewSelect = $('view-mode');
            if (viewSelect) viewSelect.value = 'total';
            render();

            addLog(`📥 已${mode === 'replace' ? '覆盖' : '合并'}导入 · 历史共 ${fmt(merged.draws)} 抽`, 'success');
        });

        picker.click();
    }

    /* =========================================================
       站内信清理

       站点每抽一次就发一封「幸运大转盘 中奖通知」，挂机一晚收件箱
       就被埋了（线上实测 1,385 封信里 1,362 封是这个）。
       删除走的就是收件箱那个表单：POST action=moveordel + messages[] + delete。

       只删主题里带「幸运大转盘」的，别的一封不碰 —— 同一个收件箱里
       还混着「种子被删除」「憨豆 改变」这类真要看的通知。
    ========================================================= */

    /* 从一页收件箱里抠出「消息 id + 主题」。站点的列表行长这样：
       <div class="grid …"><input name="messages[]" value="ID">…<a href="…viewmessage&id=ID">主题</a></div> */
    function parseMailboxPage(doc) {
        return Array.from(doc.querySelectorAll('input[name="messages[]"]'))
            .map(box => {
                const row = box.closest('div.grid') || box.parentElement?.parentElement;
                const link = row?.querySelector('a[href*="viewmessage"]');
                return { id: box.value, subject: (link?.textContent || '').trim() };
            })
            .filter(item => item.id);
    }

    const isLotteryMail = item => item.subject.includes(CONFIG.lotteryMailKeyword);

    /* 站点的翻页下拉框每页一个 <option>，直接就是总页数。
       比「数这页有几封」可靠得多 —— 每页显示多少封是用户自己设的。 */
    function readPageCount(doc) {
        const select = doc.querySelector('select[onchange*="switchPage"]');
        return select ? select.options.length : 0;
    }

    async function fetchMailboxPage(page) {
        const url = `${CONFIG.mailboxPage}?action=viewmailbox&box=1&page=${page}`;
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error(`收件箱第 ${page + 1} 页读取失败（${response.status}）`);

        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        return { items: parseMailboxPage(doc), pageCount: readPageCount(doc) };
    }

    /* 翻完整个收件箱。

       页数按翻页下拉框来。**不能靠「这页不满 100 封就是最后一页」判断** ——
       每页显示多少封是用户自己在站点设置里定的，见过设成 10 封的，
       那样翻一页就以为到底了，第 11 封往后全删不掉。
       下拉框读不到时才退回长度判断，并且以第一页的实际条数为准。 */
    async function scanMailbox(firstPage = null) {
        const all = [];
        const seen = new Set();
        let totalPages = CONFIG.mailboxMaxPages;
        let pageSize = 0;
        let hasPageCount = false;

        for (let page = 0; page < Math.min(totalPages, CONFIG.mailboxMaxPages); page++) {
            // 第一页多半刚才探测页数时已经拉过了，别再拉一遍
            const { items, pageCount } = (page === 0 && firstPage)
                ? firstPage
                : await fetchMailboxPage(page);

            if (page === 0) {
                hasPageCount = pageCount > 0;
                if (hasPageCount) totalPages = pageCount;
                pageSize = items.length;
            }

            if (!items.length) break;
            // 站点要是不认 page 参数、每页都返回同一批，及时收手
            if (items.every(item => seen.has(item.id))) break;

            items.forEach(item => {
                if (seen.has(item.id)) return;
                seen.add(item.id);
                all.push(item);
            });

            if (!hasPageCount && items.length < pageSize) break;
        }

        return all;
    }

    /* 把一张表单按当前值序列化。改站点设置必须整张表回填 ——
       usercp 一次收下全部 83 个字段，只提交想改的那个，其余全会被清成默认值。 */
    function serializeForm(form) {
        const data = new URLSearchParams();

        Array.from(form.elements).forEach(element => {
            const name = element.name;
            if (!name || element.disabled) return;

            const type = String(element.type || '').toLowerCase();
            if (['submit', 'button', 'reset', 'image', 'file'].includes(type)) return;

            if (type === 'checkbox' || type === 'radio') {
                if (element.checked) data.append(name, element.value);
                return;
            }

            if (element.tagName === 'SELECT' && element.multiple) {
                Array.from(element.selectedOptions).forEach(option => data.append(name, option.value));
                return;
            }

            data.append(name, element.value);
        });

        return data;
    }

    /* 把「每页站内信条数」改成 target，返回改完后站点上的实际值。
       只动 pmnum 一项，其余设定原样回填。 */
    async function setMailPageSize(target) {
        const settingsUrl = `${CONFIG.userCpPage}?action=tracker`;

        const page = await fetch(settingsUrl, { credentials: 'include' });
        if (!page.ok) throw new Error(`打不开网站设定页（${page.status}）`);

        const doc = new DOMParser().parseFromString(await page.text(), 'text/html');
        const form = Array.from(doc.querySelectorAll('form'))
            .find(item => item.querySelector('[name="pmnum"]'));
        if (!form) throw new Error('网站设定页里没找到「每页站内信条数」，站点大概改版了');

        const body = serializeForm(form);
        // 防呆：字段数明显不对就别提交，免得把一整页设定冲成默认值
        if (Array.from(body.keys()).length < 10) {
            throw new Error('网站设定表单读出来不完整，已放弃修改');
        }

        body.set('pmnum', String(target));

        const saved = await fetch(CONFIG.userCpPage, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });
        if (!saved.ok) throw new Error(`保存网站设定失败（${saved.status}）`);

        // 站点未必会报错，回头核一遍到底生效没有
        const after = await fetch(settingsUrl, { credentials: 'include' });
        if (!after.ok) return 0;

        const value = new DOMParser().parseFromString(await after.text(), 'text/html')
            .querySelector('[name="pmnum"]')?.value;
        return Number(value) || 0;
    }

    /* 收件箱每页显示多少封是站点设置里的 pmnum。设成 10 的话，
       一千多封信要翻一百多页才扫得完。页数多的时候问一句要不要调到 100，
       答过一次就记下来，不再打扰。 */
    async function offerBiggerMailPage() {
        const first = await fetchMailboxPage(0);

        if (settings.mailPageSizePrompted) return first;
        if (first.pageCount <= CONFIG.mailPageSizeAskAfterPages) return first;
        if (!first.items.length || first.items.length >= CONFIG.mailPageSizeTarget) return first;

        // 不管答什么都只问这一次
        settings.mailPageSizePrompted = true;
        saveSettings();

        if (await askMailPageSize(first.items.length, first.pageCount) !== 'bump') {
            addLog('好，保持现在的每页条数', 'info');
            return first;
        }

        try {
            const now = await setMailPageSize(CONFIG.mailPageSizeTarget);
            if (now >= CONFIG.mailPageSizeTarget) {
                addLog(`⚡ 每页站内信条数已改成 ${now}（原 ${first.items.length}）`, 'success');
                // 页大小变了，刚才那一页的分页作废，让扫描重新拉
                return null;
            }
            addLog(`⚠️ 设定提交了，但每页条数是 ${now || '未知'}，站点可能有上限`, 'warning');
        } catch (error) {
            addLog(`⚠️ ${error.message}`, 'warning');
        }

        return first;
    }

    function askMailPageSize(pageSize, pageCount) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'hh-modal-overlay';
            overlay.innerHTML = `
                <div class="hh-modal">
                    <div class="hh-modal-title">⚡ 扫得有点慢</div>
                    <div class="hh-modal-text">
                        你的收件箱每页只显示 <b>${fmt(pageSize)}</b> 封，
                        扫完要翻 <b>${fmt(pageCount)}</b> 页。<br>
                        改成每页 ${CONFIG.mailPageSizeTarget} 封能少翻九成。<br>
                        <span style="opacity:.75">改的是站点「控制面板 → 网站设定」里的
                        「每页站内信条数」，其余设定按当前值原样回填。</span>
                    </div>
                    <button class="hh-modal-btn hh-modal-primary" data-mode="bump">
                        改成每页 ${CONFIG.mailPageSizeTarget} 封
                        <span>只动这一项</span>
                    </button>
                    <button class="hh-modal-btn hh-modal-ghost" data-mode="keep">不用，就这样扫</button>
                </div>
            `;

            const done = mode => {
                overlay.remove();
                document.removeEventListener('keydown', onKey);
                resolve(mode);
            };
            const onKey = event => {
                if (event.key === 'Escape') done('keep');
            };

            overlay.addEventListener('click', event => {
                const button = event.target.closest('[data-mode]');
                if (button) return done(button.dataset.mode);
                if (event.target === overlay) done('keep');
            });
            document.addEventListener('keydown', onKey);

            document.body.appendChild(overlay);
        });
    }

    /* 反复清第一页，直到第一页不再有抽奖通知。
       一页可能只有 10 封，清一次远不够，所以要循环。 */
    async function sweepLotteryMail() {
        let removed = 0;

        for (let round = 0; round < CONFIG.mailSweepMaxRounds; round++) {
            const { items } = await fetchMailboxPage(0);
            const ids = items.filter(isLotteryMail).map(item => item.id);
            if (!ids.length) break;
            removed += await deleteMail(ids);
        }

        return removed;
    }

    async function deleteMail(ids) {
        let done = 0;

        for (let at = 0; at < ids.length; at += CONFIG.mailDeleteChunk) {
            const chunk = ids.slice(at, at + CONFIG.mailDeleteChunk);
            const body = new URLSearchParams();

            body.append('action', 'moveordel');
            chunk.forEach(id => body.append('messages[]', id));
            body.append('delete', '删除');

            const response = await fetch(CONFIG.mailboxPage, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body
            });
            if (!response.ok) throw new Error(`删除失败（${response.status}）`);

            done += chunk.length;
        }

        return done;
    }

    /* 挂机期间顺手清。新信都排在最前面，所以只看第一页 ——
       但一页可能只有 10 封，而两次校准之间会攒 25 封，
       所以要清到第一页没有抽奖通知为止，否则永远追不上。 */
    async function autoCleanMail() {
        if (!settings.autoCleanMail || cleaningMail) return;

        cleaningMail = true;
        try {
            const removed = await sweepLotteryMail();
            if (!removed) return;

            mailCleaned += removed;
            addLog(`📪 清掉 ${fmt(removed)} 封抽奖通知 · 本次累计 ${fmt(mailCleaned)} 封`, 'info');
        } catch (error) {
            // 清信失败不该影响抽奖，记一行就算了
            addLog(`⚠️ 站内信清理失败：${error.message}`, 'warning');
        } finally {
            cleaningMail = false;
        }
    }

    /* 一键清空：先把整个收件箱扫一遍，把「要删多少 / 留多少」摆给用户看了再动手 */
    async function purgeMailbox() {
        if (cleaningMail) return;

        const button = $('purge-mail');
        const restore = () => {
            cleaningMail = false;
            if (button) {
                button.disabled = false;
                button.textContent = '🗑 立即清空';
            }
        };

        cleaningMail = true;
        if (button) {
            button.disabled = true;
            button.textContent = '扫描中…';
        }

        try {
            // 页数太多的话先问一句要不要把每页条数调大，能省一大截请求。
            // 顺手把第一页带回来给扫描复用，不额外多发请求。
            const firstPage = await offerBiggerMailPage();

            addLog('🔍 正在扫描收件箱…', 'info');
            const all = await scanMailbox(firstPage);
            const targets = all.filter(isLotteryMail);
            const keep = all.length - targets.length;

            if (!all.length) {
                addLog('✅ 收件箱是空的', 'success');
                return;
            }

            const mode = await askMailPurge(targets.length, keep);
            if (mode !== 'lottery' && mode !== 'all') {
                addLog('已取消，一封都没删', 'info');
                return;
            }

            const doomed = mode === 'all' ? all : targets;
            if (!doomed.length) {
                addLog(`✅ 收件箱里没有抽奖通知（共 ${fmt(all.length)} 封）`, 'success');
                return;
            }

            if (button) button.textContent = '删除中…';
            let removed = await deleteMail(doomed.map(item => item.id));

            if (mode === 'all') {
                addLog(`🗑 已清空收件箱 · 共 ${fmt(removed)} 封`, 'success');
                return;
            }

            // 扫描到删完这几秒里可能又进了新的中奖通知 —— 它们不在刚才那份
            // id 清单里，会被剩下。补扫收尾。
            // 只在「只删抽奖通知」时做：全部删除模式下再扫一遍，
            // 有可能把这期间刚到的正经站内信一起带走。
            removed += await sweepLotteryMail();

            addLog(`🗑 已删除 ${fmt(removed)} 封抽奖通知，其余 ${fmt(keep)} 封原样保留`, 'success');
        } catch (error) {
            addLog(`⚠️ ${error?.message || error}`, 'error');
        } finally {
            restore();
        }
    }

    function askMailPurge(targetCount, keepCount) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'hh-modal-overlay';
            overlay.innerHTML = `
                <div class="hh-modal">
                    <div class="hh-modal-title">🗑 清理收件箱</div>
                    <div class="hh-modal-text">
                        收件箱共 <b>${fmt(targetCount + keepCount)}</b> 封：<br>
                        「${CONFIG.lotteryMailKeyword}」通知 <b>${fmt(targetCount)}</b> 封，
                        其他站内信 <b>${fmt(keepCount)}</b> 封。<br>
                        删除不可撤销。
                    </div>
                    <button class="hh-modal-btn hh-modal-primary" data-mode="lottery">
                        只删抽奖通知 · ${fmt(targetCount)} 封
                        <span>其余 ${fmt(keepCount)} 封原样保留</span>
                    </button>
                    <button class="hh-modal-btn" data-mode="all">
                        全部删除 · ${fmt(targetCount + keepCount)} 封
                        <span>连「种子被删除」这类通知一起清掉</span>
                    </button>
                    <button class="hh-modal-btn hh-modal-ghost" data-mode="cancel">取消</button>
                </div>
            `;

            const done = mode => {
                overlay.remove();
                document.removeEventListener('keydown', onKey);
                resolve(mode);
            };
            const onKey = event => {
                if (event.key === 'Escape') done('cancel');
            };

            overlay.addEventListener('click', event => {
                const button = event.target.closest('[data-mode]');
                if (button) return done(button.dataset.mode);
                if (event.target === overlay) done('cancel');
            });
            document.addEventListener('keydown', onKey);

            document.body.appendChild(overlay);
        });
    }

    /* =========================================================
       拖动（兼容触屏）
    ========================================================= */

    function enableDragging() {
        const panel = $('lottery-control-panel');
        const title = $('hh-title-bar');
        if (!panel || !title) return;

        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        const pointOf = event => (event.touches ? event.touches[0] : event);

        const start = event => {
            if (event.target.closest('button,input,select')) return;

            const point = pointOf(event);
            const rect = panel.getBoundingClientRect();

            dragging = true;
            offsetX = point.clientX - rect.left;
            offsetY = point.clientY - rect.top;
            event.preventDefault();
        };

        const move = event => {
            if (!dragging) return;

            // 触屏上不拦下来的话，拖面板会同时把页面滚走
            if (event.cancelable) event.preventDefault();

            const point = pointOf(event);
            const maxLeft = Math.max(5, window.innerWidth - panel.offsetWidth);
            const maxTop = Math.max(5, window.innerHeight - panel.offsetHeight);

            const left = Math.max(5, Math.min(point.clientX - offsetX, maxLeft));
            const top = Math.max(5, Math.min(point.clientY - offsetY, maxTop));

            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
            panel.style.right = 'auto';
        };

        const end = () => {
            if (!dragging) return;
            dragging = false;

            settings.panelLeft = parseInt(panel.style.left, 10) || null;
            settings.panelTop = parseInt(panel.style.top, 10) || null;
            saveSettings();
        };

        title.addEventListener('mousedown', start);
        title.addEventListener('touchstart', start, { passive: false });
        document.addEventListener('mousemove', move);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('mouseup', end);
        document.addEventListener('touchend', end);
    }

    function restorePanelPosition() {
        const panel = $('lottery-control-panel');
        if (!panel || settings.panelLeft === null || settings.panelTop === null) return;

        const left = Math.max(5, Math.min(settings.panelLeft, window.innerWidth - 100));
        const top = Math.max(5, Math.min(settings.panelTop, window.innerHeight - 100));

        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = 'auto';
    }

    /* 窗口缩小后面板可能被留在视口外，标题栏都抓不到就再也拖不回来了 */
    function keepPanelInViewport() {
        const panel = $('lottery-control-panel');
        if (!panel || panel.style.left === '') return;

        const maxLeft = Math.max(5, window.innerWidth - panel.offsetWidth);
        const maxTop = Math.max(5, window.innerHeight - panel.offsetHeight);
        const left = Math.max(5, Math.min(parseInt(panel.style.left, 10) || 5, maxLeft));
        const top = Math.max(5, Math.min(parseInt(panel.style.top, 10) || 5, maxTop));

        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;

        settings.panelLeft = left;
        settings.panelTop = top;
        saveSettings();
    }

    /* =========================================================
       初始化
    ========================================================= */

    function bindEvents() {
        on('start-lottery', 'click', startLottery);
        on('stop-lottery', 'click', () => stopLottery('🛑 用户手动停止抽奖'));

        on('set-max-possible', 'click', () => {
            const max = updateBalanceDisplay();
            const input = $('max-lottery-count');
            if (input) {
                input.value = Math.max(1, max);
                settings.maxCount = Math.max(1, max);
                saveSettings();
            }
            addLog(`🎯 已将最大次数设置为 ${max}`, 'info');
        });

        on('view-mode', 'change', event => {
            settings.viewMode = event.target.value;
            saveSettings();
            render();
        });

        on('follow-duration', 'change', event => {
            settings.followDuration = !!event.target.checked;
            saveSettings();
            applyDurationUI();
            setDurationInfo();
        });

        on('duration-buffer', 'change', event => {
            const value = normalizeBufferMs(event.target.value, settings.bufferMs);
            event.target.value = value;
            settings.bufferMs = value;
            saveSettings();
            setDurationInfo();
        });

        on('lottery-interval', 'change', event => {
            const value = normalizeInterval(event.target.value, settings.interval);
            event.target.value = intervalText(value);
            settings.interval = value;
            saveSettings();

            // 运行中改间隔立刻生效，不必重启；没在跑的时候也要跟上，
            // 否则「当前间隔」会一直挂着上一次的数，和输入框对不上。
            // 自适应开着时这个值根本不参与节奏，改了也只是存起来备用。
            dynamicInterval = Math.round(value * 1000);
            setCurrentIntervalDisplay();
        });

        on('max-lottery-count', 'change', event => {
            const value = Math.max(1, parseInt(event.target.value, 10) || settings.maxCount);
            event.target.value = value;
            settings.maxCount = value;
            saveSettings();
        });

        on('refresh-balance', 'click', () => calibrateBalance());
        on('backup-stats', 'click', backupStats);
        on('import-stats', 'click', importStats);

        on('drain-mode', 'change', event => {
            settings.drainMode = event.target.checked;
            saveSettings();
            applyDrainUI();
        });

        on('purge-mail', 'click', purgeMailbox);

        on('auto-clean-mail', 'change', event => {
            settings.autoCleanMail = event.target.checked;
            saveSettings();
            applyMailUI();
        });

        on('stop-on-jackpot', 'change', event => {
            settings.stopOnJackpot = event.target.checked;
            saveSettings();
            applyJackpotStopUI();
        });

        on('reserve-beans', 'change', event => {
            const value = Math.max(0, parseInt(event.target.value, 10) || 0);
            event.target.value = value;
            settings.reserveBeans = value;
            saveSettings();
        });

        on('reset-current-data', 'click', resetCurrentData);
        on('clear-total-data', 'click', clearTotalData);
        on('export-stats', 'click', exportStats);

        on('toggle-all-tiers', 'click', () => {
            const rows = Array.from(document.querySelectorAll('#detail-list .hh-row'));
            const shouldOpen = rows.some(row => !row.classList.contains('is-open'));

            rows.forEach(row => row.classList.toggle('is-open', shouldOpen));
            settings.detailOpen = shouldOpen ? 'all' : 'none';
            saveSettings();

            setText('toggle-all-tiers', shouldOpen ? '🔼 收起全部档位' : '🔽 展开全部档位');
        });

        on('toggle-animation', 'click', () => {
            settings.animation = !settings.animation;
            saveSettings();
            setText('toggle-animation', `🎉 中奖动画：${settings.animation ? '开' : '关'}`);
        });

        // 其他标签页写入历史统计时同步过来
        window.addEventListener('storage', event => {
            if (event.key !== STATS_KEY) return;
            totalStats = loadStats();
            if (settings.viewMode === 'total') render();
        });

        window.addEventListener('resize', keepPanelInViewport);
        document.addEventListener('visibilitychange', onVisibilityBack);

        // 关页面时如果还在抽，提醒一下
        window.addEventListener('beforeunload', event => {
            if (!running) return;
            event.preventDefault();
            event.returnValue = '';
        });
    }

    function applySettingsToUI() {
        const intervalInput = $('lottery-interval');
        if (intervalInput) intervalInput.value = intervalText(settings.interval);

        const maxInput = $('max-lottery-count');
        if (maxInput) maxInput.value = settings.maxCount;

        const viewSelect = $('view-mode');
        if (viewSelect) viewSelect.value = settings.viewMode;

        const followToggle = $('follow-duration');
        if (followToggle) followToggle.checked = !!settings.followDuration;

        const bufferInput = $('duration-buffer');
        if (bufferInput) bufferInput.value = settings.bufferMs;

        const drainToggle = $('drain-mode');
        if (drainToggle) drainToggle.checked = !!settings.drainMode;

        const reserveInput = $('reserve-beans');
        if (reserveInput) reserveInput.value = Math.max(0, settings.reserveBeans);

        const mailToggle = $('auto-clean-mail');
        if (mailToggle) mailToggle.checked = !!settings.autoCleanMail;

        const jackpotStopToggle = $('stop-on-jackpot');
        if (jackpotStopToggle) jackpotStopToggle.checked = !!settings.stopOnJackpot;

        applyDurationUI();
        applyDrainUI();
        applyMailUI();
        applyJackpotStopUI();

        setText('toggle-animation', `🎉 中奖动画：${settings.animation ? '开' : '关'}`);
        setText('toggle-all-tiers', settings.detailOpen === 'all' ? '🔼 收起全部档位' : '🔽 展开全部档位');

        dynamicInterval = Math.round(settings.interval * 1000);
        setCurrentIntervalDisplay();
        setDurationInfo();
    }

    /* 一抽到底开着时「最大抽奖次数」不起作用，置灰，免得以为设了有用 */
    function applyDurationUI() {
        $('duration-hint')?.classList.toggle('is-on', !!settings.followDuration);
        const info = $('duration-info');
        if (info) info.style.display = settings.followDuration ? '' : 'none';

        const buffer = $('duration-buffer');
        if (buffer) {
            buffer.disabled = !settings.followDuration;
            buffer.style.opacity = settings.followDuration ? '' : '.45';
        }

        // 自适应接管以后手填的间隔完全不生效，置灰免得以为还管用
        const interval = $('lottery-interval');
        if (interval) {
            interval.disabled = !!settings.followDuration;
            interval.style.opacity = settings.followDuration ? '.45' : '';
        }

        setCurrentIntervalDisplay();
    }

    function applyDrainUI() {
        const maxInput = $('max-lottery-count');
        if (maxInput) {
            maxInput.disabled = !!settings.drainMode;
            maxInput.style.opacity = settings.drainMode ? '.45' : '';
        }

        const setMaxButton = $('set-max-possible');
        if (setMaxButton) setMaxButton.disabled = !!settings.drainMode;

        $('drain-hint')?.classList.toggle('is-on', !!settings.drainMode);
    }

    function applyMailUI() {
        $('mail-hint')?.classList.toggle('is-on', !!settings.autoCleanMail);
    }

    function applyJackpotStopUI() {
        $('jackpot-stop-hint')?.classList.toggle('is-on', !!settings.stopOnJackpot);
    }

    function init() {
        if ($('lottery-control-panel')) return;

        loadSettings();
        totalStats = loadStats();

        injectStyle();
        createControlPanel();

        applySettingsToUI();
        bindEvents();
        enableDragging();
        restorePanelPosition();

        updateBalanceDisplay();
        render();

        addLog('🎈 HHCLUB 自动抽奖 · 情绪价值拉满版已加载', 'success');
        addLog('🌐 当前站点：hhanclub.net', 'info');
        addLog('🎁 自动抽奖 Dashboard 已准备就绪', 'info');

        if (totalStats.migratedFrom === 'v3') {
            addLog('📦 已迁移旧版历史统计数据', 'success');
        }

        warnIfPoolOpaque();


        setInterval(() => {
            getSingleCost();
            updateBalanceDisplay();
        }, 10000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

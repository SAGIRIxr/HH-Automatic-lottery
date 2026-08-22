/**
 * HHCLUB 自动抽奖 · 情绪价值拉满版 —— 行为测试
 *
 * 在 jsdom 里加载真实脚本，stub 掉抽奖接口，验证：
 *   - 分奖项统计的聚合结果
 *   - v3 历史数据迁移
 *   - 串行抽奖循环 / 退避 / 自动停止
 *
 * 运行：npm test（用的是真实计时器，跑完约 90 秒）
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = fs.readFileSync(path.join(ROOT, 'hhclub-auto-lottery.user.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

function makeDom({ legacy = null, pool = null, useBean = '每次消耗 2,000 憨豆', balance = '1,234,567',
                   vipSwapBeans = 1000000 } = {}) {
    // pool 传入时按抽奖页真实的内联脚本形状渲染一段 <script>，
    // 让脚本走和线上完全一样的奖池读取路径。
    const poolScript = pool
        ? `<script>
    let imgPath = 'pic/lucky';
    let prizes = ${JSON.stringify(pool)};
    let awards = [];
</script>`
        : '';

    const dom = new JSDOM(`<!doctype html><html><body>
        <div class="use-bean">${useBean}</div>
        <div class="bean-number">${balance}</div>
        <div class="hint">当中奖 [VIP] 时，如果用户已经是 VIP 或以上等级，奖励憨豆： ${vipSwapBeans}</div>
        ${poolScript}
    </body></html>`, {
        url: 'https://hhanclub.net/lucky.php',
        runScripts: 'outside-only',
        // 不开这个的话 jsdom 的 visibilityState 是 prerender、document.hidden 为 true，
        // 脚本会把中奖动画全部当成「页面在后台」跳过，动画相关断言就全是假阴性。
        pretendToBeVisual: true
    });

    const w = dom.window;
    w.confirm = () => true;
    w.alert = () => {};
    w.URL.createObjectURL = () => 'blob:stub';
    w.URL.revokeObjectURL = () => {};
    if (legacy) w.localStorage.setItem('hhanclub_lottery_stats_v3', JSON.stringify(legacy));
    return dom;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 固定 sleep 会白等一大截 —— 轮询到条件成立就往下走，全套能省一半时间
async function until(fn, timeoutMs = 90000, stepMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fn()) return true;
        await sleep(stepMs);
    }
    return false;
}
const untilStopped = (d, timeoutMs) =>
    until(() => d.getElementById('lottery-status').textContent === '已停止', timeoutMs);

// jsdom 构造完成时 readyState 可能还是 loading，脚本会等 DOMContentLoaded，
// 所以 eval 之后要让出一拍再断言。
async function run(dom, { followDuration = false } = {}) {
    // 跟随转盘时长默认开着，但多数用例验的是「填几秒就跑几秒」。
    // 要测跟随行为的用例自己打开。
    const key = 'hhanclub_lottery_settings_v1';
    const saved = JSON.parse(dom.window.localStorage.getItem(key) || '{}');
    saved.followDuration = followDuration;
    dom.window.localStorage.setItem(key, JSON.stringify(saved));

    dom.window.eval(SRC);
    await sleep(150);
}

/* ---------------------------------------------------------------- */
console.log('\n[1] 面板与 A1 修复（详细统计容器必须可见）');
{
    const dom = makeDom();
    await run(dom);
    const d = dom.window.document;

    check('面板已创建', !!d.getElementById('lottery-control-panel'));
    check('奖项明细容器存在', !!d.getElementById('detail-list'));

    const list = d.getElementById('detail-list');
    const hidden = list.closest('[style*="display:none"]') || list.closest('[style*="display: none"]');
    check('明细容器没有被 display:none 挡住', !hidden);
    check('空状态提示可见', list.textContent.includes('每个奖项的中奖次数'));
    check('旧的 prize-stats 隐藏容器已移除', !d.getElementById('prize-stats'));
}

/* ---------------------------------------------------------------- */
console.log('\n[2] B4 修复：千分位单次消耗解析');
{
    const dom = makeDom();
    await run(dom);
    const d = dom.window.document;

    check('单次消耗 = 2,000 而不是 2', d.getElementById('single-cost').textContent === '2,000',
        `实际 "${d.getElementById('single-cost').textContent}"`);
    check('余额正确解析千分位', d.getElementById('bean-balance').textContent === '1,234,567',
        `实际 "${d.getElementById('bean-balance').textContent}"`);
    check('可抽次数 = floor(1234567/2000) = 617',
        d.getElementById('max-possible').textContent === '617',
        `实际 "${d.getElementById('max-possible').textContent}"`);
}

/* ---------------------------------------------------------------- */
console.log('\n[3] 分奖项统计聚合（A2 核心）');
{
    const dom = makeDom();
    const w = dom.window;

    // 固定的奖池序列，便于断言
    const prizes = [
        '恭喜获得 500 憨豆', '恭喜获得 500 憨豆', '恭喜获得 1,000 憨豆',
        '恭喜获得 500 憨豆', '恭喜获得 3 天彩虹ID', '恭喜获得 1 个邀请',
        '恭喜获得 1,000 憨豆', '恭喜获得 7 天VIP', '恭喜获得 1 张补签卡',
        '恭喜获得 5GB 上传量'
    ];
    let i = 0;
    let calls = 0;
    w.fetch = async url => {
        // 序列里有一注 VIP，脚本中到 VIP 会回服务端核一次余额 ——
        // 那一发不是抽奖请求，不能从奖品序列里取，否则整条序列错位
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        calls++;
        const text = prizes[i % prizes.length];
        i++;
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: text, winning_record_id: 1000 + i } })
        };
    };

    await run(dom);
    const d = w.document;

    // 这一组验的是统计怎么聚合，跟间隔多长没关系，用下限跑最快
    d.getElementById('lottery-interval').value = '0.5';
    d.getElementById('max-lottery-count').value = '10';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 40000);

    check(`实际发出 10 次请求（发出 ${calls} 次）`, calls === 10);

    const stats = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('抽奖次数 = 10', stats.draws === 10, `实际 ${stats.draws}`);
    check('累计消耗 = 10 × 2000 = 20000', stats.cost === 20000, `实际 ${stats.cost}`);

    check('憨豆类别中奖 5 次', stats.prizes.beans?.count === 5, `实际 ${stats.prizes.beans?.count}`);
    check('憨豆档位 500 中 3 次', stats.prizes.beans?.tiers['500 憨豆'] === 3,
        JSON.stringify(stats.prizes.beans?.tiers));
    check('憨豆档位 1,000 中 2 次', stats.prizes.beans?.tiers['1,000 憨豆'] === 2,
        JSON.stringify(stats.prizes.beans?.tiers));
    check('憨豆累计数值 = 500*3 + 1000*2 = 3500', stats.gains.beans === 3500, `实际 ${stats.gains.beans}`);

    check('彩虹ID 中 1 次 / 累计 3 天',
        stats.prizes.rainbow?.count === 1 && stats.gains.rainbow === 3);
    check('VIP 中 1 次 / 累计 7 天',
        stats.prizes.vip?.count === 1 && stats.gains.vip === 7);
    check('邀请中 1 次', stats.prizes.invite?.count === 1);
    check('补签卡中 1 次', stats.prizes.makeup?.count === 1);
    check('上传量中 1 次 / 累计 5GB',
        stats.prizes.upload?.count === 1 && stats.gains.upload === 5);

    const typeTotal = Object.values(stats.prizes).reduce((s, b) => s + b.count, 0);
    check('分奖项次数之和 == 抽奖次数', typeTotal === stats.draws, `${typeTotal} vs ${stats.draws}`);

    // UI 断言
    check('面板抽奖次数显示 10', d.getElementById('draw-count').textContent === '10',
        `实际 "${d.getElementById('draw-count').textContent}"`);
    check('面板奖项种类显示 6', d.getElementById('prize-type-count').textContent === '6',
        `实际 "${d.getElementById('prize-type-count').textContent}"`);

    const rows = [...d.querySelectorAll('#detail-list .hh-row')];
    check('明细渲染出 6 行', rows.length === 6, `实际 ${rows.length}`);
    check('第一行是次数最多的憨豆', rows[0]?.dataset.type === 'beans', rows[0]?.dataset.type);
    check('憨豆行显示 "5 次"', rows[0]?.querySelector('.hh-row-count')?.textContent === '5 次',
        rows[0]?.querySelector('.hh-row-count')?.textContent);
    check('憨豆行占比 50.0%', rows[0]?.querySelector('.hh-row-pct')?.textContent === '50.0%',
        rows[0]?.querySelector('.hh-row-pct')?.textContent);
    check('憨豆行展开后有 2 个档位', rows[0]?.querySelectorAll('.hh-tier').length === 2);
    check('明细汇总文案正确',
        d.getElementById('detail-summary').textContent === '共 10 抽 · 6 种',
        d.getElementById('detail-summary').textContent);

    check('盈亏 = 3500 - 20000',
        d.getElementById('profit-loss').textContent === '-16,500',
        d.getElementById('profit-loss').textContent);

    // B1: 串行执行，任意时刻只有一个 in-flight 请求 —— 由 calls===10 且无重复扣豆间接验证
    check('达到最大次数后自动停止', d.getElementById('lottery-status').textContent === '已停止',
        d.getElementById('lottery-status').textContent);
    check('停止后开始按钮恢复可用', d.getElementById('start-lottery').disabled === false);
}

/* ---------------------------------------------------------------- */
console.log('\n[4] A4：v3 历史数据迁移');
{
    const legacy = {
        totalLotteryCount: 100,
        totalWinCount: 100,
        totalCost: 200000,
        totalBeansWon: 45000,
        totalInvites: 2,
        totalRainbowDays: 10,
        totalVipDays: 7,
        totalMakeupCards: 3,
        totalUploadGB: 15,
        totalPrizeStats: {
            '恭喜获得 500 憨豆': 60,
            '恭喜获得 1,000 憨豆': 25,
            '恭喜获得 3 天彩虹ID': 8,
            '恭喜获得 1 个邀请': 2,
            '恭喜获得 7 天VIP': 1,
            '恭喜获得 5GB 上传量': 3,
            '恭喜获得 1 张补签卡': 1
        }
    };
    const dom = makeDom({ legacy });
    await run(dom);
    const w = dom.window, d = w.document;

    const stats = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('迁移标记正确', stats.migratedFrom === 'v3');
    check('历史抽奖次数保留 100', stats.draws === 100, `实际 ${stats.draws}`);
    check('历史消耗保留 200000', stats.cost === 200000);
    check('历史憨豆保留 45000', stats.gains.beans === 45000);
    check('憨豆按文案重建为 85 次', stats.prizes.beans?.count === 85, `实际 ${stats.prizes.beans?.count}`);
    check('憨豆 500 档位 60 次', stats.prizes.beans?.tiers['500 憨豆'] === 60);
    check('憨豆 1,000 档位 25 次', stats.prizes.beans?.tiers['1,000 憨豆'] === 25);
    check('彩虹重建为 8 次', stats.prizes.rainbow?.count === 8);
    check('原始文案兜底保留', Object.keys(stats.raw).length === 7);

    d.getElementById('view-mode').value = 'total';
    d.getElementById('view-mode').dispatchEvent(new w.Event('change'));
    check('切到历史后抽奖次数显示 100', d.getElementById('draw-count').textContent === '100',
        d.getElementById('draw-count').textContent);
    check('切到历史后明细有 6 行',
        d.querySelectorAll('#detail-list .hh-row').length === 6,
        String(d.querySelectorAll('#detail-list .hh-row').length));
}

/* ---------------------------------------------------------------- */
console.log('\n[5] 接口一直失败也不停机，按阶梯拉长重试');
{
    // 挂机是无人值守的：站点重启、网线抖一下，人不在跟前，
    // 停了就是整夜白过。改成一直重试，每 3 次抬一档等待时间。
    const dom = makeDom();
    const w = dom.window;
    const stamps = [];
    w.fetch = async () => { stamps.push(Date.now()); throw new Error('network down'); };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '100';
    d.getElementById('start-lottery').click();

    // 基数 1 秒：1 1 1 · 1.5 1.5 1.5 · 2.25 …，10 秒够看到抬档
    await sleep(10000);

    check('没有停机，还在重试', d.getElementById('lottery-status').textContent !== '已停止',
        d.getElementById('lottery-status').textContent);
    check(`一直在发请求（10 秒发了 ${stamps.length} 次）`, stamps.length >= 5,
        `实际 ${stamps.length}`);

    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    check('前三次按基数 1 秒重试',
        gaps.slice(0, 2).every(gap => gap >= 850 && gap < 1400), gaps.join(' / '));
    check('第四次起抬到 1.5 秒档',
        gaps.slice(3, 5).every(gap => gap >= 1350 && gap < 1900), gaps.join(' / '));
    check('等待是一路变长的，没有退回去',
        gaps[gaps.length - 1] >= gaps[0], gaps.join(' / '));

    check('失败不计入抽奖次数',
        d.getElementById('draw-count').textContent === '0',
        d.getElementById('draw-count').textContent);

    d.getElementById('stop-lottery').click();
    await untilStopped(d, 5000);
    check('手动点停止照样立刻停得下来',
        d.getElementById('lottery-status').textContent === '已停止');
}

/* ---------------------------------------------------------------- */
console.log('\n[6] B3：限流退避后成功能恢复间隔');
{
    const dom = makeDom();
    const w = dom.window;
    let n = 0;
    w.fetch = async () => {
        n++;
        // 前 3 次限流，之后成功
        const body = n <= 3
            ? { ret: 1, msg: '请勿重复点击' }
            : { ret: 0, data: { prize_text: '恭喜获得 500 憨豆' } };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '4';
    d.getElementById('start-lottery').click();

    // 等到第 3 次限流触发退避
    await until(() => parseFloat(d.getElementById('current-interval').textContent) > 3);
    const backedOff = parseFloat(d.getElementById('current-interval').textContent);
    check(`限流后间隔被拉长（当前 ${backedOff}s）`, backedOff > 3, `实际 ${backedOff}`);

    // 后续成功会把间隔降回基础值
    await until(() => parseFloat(d.getElementById('current-interval').textContent) === 3);
    const recovered = parseFloat(d.getElementById('current-interval').textContent);
    check(`成功后间隔降回 3s（当前 ${recovered}s）`, recovered === 3, `实际 ${recovered}`);

    // 间隔一恢复就往下走的话，后面几次还没抽 —— 等抽满再断言
    await until(() => d.getElementById('draw-count').textContent === '4');
    check('限流不计入抽奖次数，最终抽了 4 次',
        d.getElementById('draw-count').textContent === '4',
        d.getElementById('draw-count').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[7] 停止按钮能立刻中断等待');
{
    const dom = makeDom();
    const w = dom.window;
    let calls = 0;
    w.fetch = async () => {
        calls++;
        return { ok: true, status: 200, text: async () => JSON.stringify({ ret: 0, data: { prize_text: '恭喜获得 500 憨豆' } }) };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '300';
    d.getElementById('max-lottery-count').value = '100';
    d.getElementById('start-lottery').click();

    await sleep(1500);
    check('已抽第一次', calls === 1, `实际 ${calls}`);

    const t0 = Date.now();
    d.getElementById('stop-lottery').click();
    await sleep(500);
    check(`停止立即生效（耗时 ${Date.now() - t0}ms，没有等满 300s）`,
        d.getElementById('lottery-status').textContent === '已停止');

    await sleep(2000);
    check('停止后不再发请求', calls === 1, `实际 ${calls}`);
}

/* ---------------------------------------------------------------- */
console.log('\n[8] 设置持久化');
{
    const dom = makeDom();
    const w = dom.window;
    await run(dom);
    const d = w.document;

    const input = d.getElementById('lottery-interval');
    input.value = '15';
    input.dispatchEvent(new w.Event('change'));

    const saved = JSON.parse(w.localStorage.getItem('hhanclub_lottery_settings_v1'));
    check('间隔已持久化', saved.interval === 15, JSON.stringify(saved));
}

/* ----------------------------------------------------------------
   以下夹具直接取自 hhanclub.net/lucky.php 的线上真实数据（2026-08）：
   REAL_POOL 是抽奖页内联脚本里的 prizes 数组，REAL_BEANS 来自同期
   最近 500 抽的实际战绩。
   注意 typeText 写的「魔力」就是憨豆：站点奖池里 type 1001 用的是 bean_icon，
   消耗侧也叫憨豆，只是 NexusPHP 的默认叫法没改干净。所以它们必须归到同一类。
------------------------------------------------------------------ */
const REAL_POOL = [
    { typeText: '彩虹 ID', amountText: '7 Day(s)', probability_real: '0.0301' },
    { typeText: '魔力', amountText: '780000 ', probability_real: '0.0011' },
    { typeText: '魔力', amountText: '5000 ', probability_real: '0.1507' },
    { typeText: 'VIP', amountText: '7 Day(s)', probability_real: '0.0002' },
    { typeText: '魔力', amountText: '100 ', probability_real: '0.2261' },
    { typeText: '补签卡', amountText: '1 ', probability_real: '0.0603' },
    { typeText: '魔力', amountText: '2000 ', probability_real: '0.2261' },
    { typeText: '上传量', amountText: '2 GB', probability_real: '0.0603' },
    { typeText: '魔力', amountText: '1000 ', probability_real: '0.2261' },
    { typeText: '上传量', amountText: '5 GB', probability_real: '0.0151' },
    { typeText: '邀请', amountText: '1 ', probability_real: '0.0038' }
];

// 「魔力」档位在最近 500 抽里的憨豆总额，用作 [10] 的盈亏种子数据
const REAL_BEANS = 100 * 122 + 5000 * 67 + 2000 * 136 + 1000 * 100 + 780000 * 2;

/* ---------------------------------------------------------------- */
console.log('\n[9] 线上真实文案的归类与官方爆率对比');
{
    // 奖池每一档各中一次。这样既走完真实的解析路径，又能验证
    // 「奖池文案」和「接口文案」必须归一化成同一个 label —— 对不上号
    // 的话档位行就配不到官方爆率。
    const TEXTS = [
        '魔力 780000 ', '魔力 5000 ', '魔力 100 ', '魔力 2000 ', '魔力 1000 ',
        '上传量 2 GB', '上传量 5 GB', '彩虹 ID 7 Day(s)', 'VIP 7 Day(s)',
        '补签卡 1 ', '邀请 1 '
    ];

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    let i = 0;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        const text = TEXTS[i++] ?? TEXTS[TEXTS.length - 1];
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: text } })
        };
    };

    await run(dom);
    const d = w.document;

    check('线上写法「每次消耗憨豆： 2000」解析为 2,000',
        d.getElementById('single-cost').textContent === '2,000',
        d.getElementById('single-cost').textContent);

    // 验的是文案怎么归类，间隔用下限
    d.getElementById('lottery-interval').value = '0.5';
    d.getElementById('max-lottery-count').value = String(TEXTS.length);
    d.getElementById('start-lottery').click();

    await untilStopped(d);

    const stats = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check(`抽满 ${TEXTS.length} 次`, stats.draws === TEXTS.length, `实际 ${stats.draws}`);
    check('线上 11 种文案没有一种落进「其他奖品」',
        !stats.prizes.unknown, JSON.stringify(stats.prizes.unknown));
    check('没有留下独立的 magic 类别', !stats.prizes.magic, JSON.stringify(stats.prizes.magic));

    check('五档「魔力」全部归到憨豆，共 5 次',
        stats.prizes.beans?.count === 5, `实际 ${stats.prizes.beans?.count}`);
    check('憨豆累计 = 780000+5000+100+2000+1000',
        stats.gains.beans === 788100, `实际 ${stats.gains.beans}`);
    check('上传量 2GB + 5GB = 7GB', stats.gains.upload === 7, `实际 ${stats.gains.upload}`);
    check('彩虹 ID 7 天', stats.gains.rainbow === 7, `实际 ${stats.gains.rainbow}`);
    check('VIP 7 天', stats.gains.vip === 7, `实际 ${stats.gains.vip}`);
    check('补签卡 1 张', stats.prizes.makeup?.count === 1);
    check('邀请 1 个', stats.prizes.invite?.count === 1);

    // 档位 label 必须和奖池对得上，否则这里配不到爆率
    const tierRates = Array.from(d.querySelectorAll('#detail-list .hh-tier-rate'));
    check(`档位行渲染出 ${TEXTS.length} 条爆率对比`,
        tierRates.length === TEXTS.length, `实际 ${tierRates.length}`);
    check('每个档位都配到了官方爆率',
        tierRates.every(el => /官方 \d/.test(el.textContent)),
        tierRates.map(el => el.textContent).join(' | '));

    const official = Array.from(d.querySelectorAll('#detail-list .hh-row-official'));
    check('6 个类别都显示官方爆率', official.length === 6, `实际 ${official.length}`);
    check('憨豆类别官方爆率合并为 83.0%',
        official.some(el => el.textContent === '官方 83.0%'),
        official.map(el => el.textContent).join(' | '));
    check('VIP 类别官方爆率 0.0%（0.02% 四舍五入）',
        official.some(el => el.textContent === '官方 0.0%'),
        official.map(el => el.textContent).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[10] 憨豆盈亏与理论盈亏率');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    // 盈亏只用到 cost 和 gains.beans，直接给一份 500 抽的种子数据，
    // 不必再为了造数据去跑几百次抽奖
    w.localStorage.setItem('hhanclub_lottery_stats_v4', JSON.stringify({
        version: 4, draws: 500, cost: 1000000,
        gains: { beans: REAL_BEANS, magic: 0, invite: 2, rainbow: 63, vip: 0, makeup: 0, upload: 86 },
        prizes: { beans: { count: 427, value: REAL_BEANS, tiers: { '100 憨豆': 122 } } },
        raw: {}
    }));

    await run(dom);
    const d = w.document;

    d.getElementById('view-mode').value = 'total';
    d.getElementById('view-mode').dispatchEvent(new w.Event('change'));
    await sleep(80);

    const profit = REAL_BEANS - 1000000;
    check(`盈亏 = ${REAL_BEANS} - 1,000,000`,
        d.getElementById('profit-loss').textContent === `+${profit.toLocaleString()}`,
        d.getElementById('profit-loss').textContent);

    const rate = (profit / 1000000) * 100;
    check(`实测盈亏率 ${rate.toFixed(1)}%`,
        d.getElementById('profit-rate').textContent === `+${rate.toFixed(1)}%`,
        d.getElementById('profit-rate').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[10b] 旧版拆出来的 magic 数据会被合回憨豆');
{
    const dom = makeDom();
    const w = dom.window;
    // 模拟本脚本早期版本存下的 v4 数据：魔力被当成独立奖项
    w.localStorage.setItem('hhanclub_lottery_stats_v4', JSON.stringify({
        version: 4, draws: 3, cost: 6000,
        gains: { beans: 500, magic: 7000, invite: 0, rainbow: 0, vip: 0, makeup: 0, upload: 0 },
        prizes: {
            beans: { count: 1, value: 500, tiers: { '500 憨豆': 1 } },
            magic: { count: 2, value: 7000, tiers: { '5,000 憨豆': 1, '2,000 憨豆': 1 } }
        },
        raw: {}
    }));

    await run(dom);
    const d = w.document;
    d.getElementById('view-mode').value = 'total';
    d.getElementById('view-mode').dispatchEvent(new w.Event('change'));
    await sleep(50);

    check('憨豆累计合并为 7,500',
        d.getElementById('total-beans-won').textContent === '7,500',
        d.getElementById('total-beans-won').textContent);
    check('明细只剩一行憨豆',
        d.querySelectorAll('#detail-list .hh-row').length === 1,
        d.querySelectorAll('#detail-list .hh-row').length);
    check('憨豆合计 3 次',
        d.querySelector('#detail-list .hh-row-count')?.textContent === '3 次',
        d.querySelector('#detail-list .hh-row-count')?.textContent);
    check('三个档位都在',
        d.querySelectorAll('#detail-list .hh-tier').length === 3,
        d.querySelectorAll('#detail-list .hh-tier').length);
    check('盈亏 = 7500 - 6000 = +1,500',
        d.getElementById('profit-loss').textContent === '+1,500',
        d.getElementById('profit-loss').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[11] 限流与接口错误分开计数');
{
    const dom = makeDom();
    const w = dom.window;
    let calls = 0;

    // 3 次限流 + 2 次网络错误。旧版两者共用一个计数器，
    // 到第 5 次就会凑够 maxConsecutiveErrors 被误判成接口异常停机。
    w.fetch = async () => {
        calls++;
        if (calls <= 3) {
            return { ok: true, status: 200, text: async () => JSON.stringify({ ret: 1, msg: '请勿重复点击' }) };
        }
        if (calls <= 5) throw new Error('network down');
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;
    // 退避倍数是相对值，间隔缩短不改变「限流和错误分开数」这件事
    d.getElementById('lottery-interval').value = '1';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();

    await untilStopped(d, 60000);
    await sleep(300);

    check(`没有在第 5 次被误停（共发出 ${calls} 次请求）`, calls > 5, `实际 ${calls}`);
    check('最终抽到了奖', Number(d.getElementById('draw-count').textContent) === 1,
        d.getElementById('draw-count').textContent);
    check('「魔力 100」记成 100 憨豆',
        JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4')).gains.beans === 100);
}

/* ---------------------------------------------------------------- */
console.log('\n[12] 余额随抽奖本地扣减（站点不刷新 .bean-number）');
{
    const dom = makeDom();
    const w = dom.window;
    let calls = 0;
    w.fetch = async () => {
        calls++;
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;

    check('初始余额取自 DOM', d.getElementById('bean-balance').textContent === '1,234,567',
        d.getElementById('bean-balance').textContent);
    check('初始最多可抽 617', d.getElementById('max-possible').textContent === '617',
        d.getElementById('max-possible').textContent);

    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '3';
    d.getElementById('start-lottery').click();
    await untilStopped(d);

    check(`抽了 3 次（实际 ${calls}）`, calls === 3);
    // 站点从不改这个元素，所以 DOM 里仍是 1,234,567
    check('DOM 里的余额确实没被站点更新',
        d.querySelector('.bean-number').textContent === '1,234,567',
        d.querySelector('.bean-number').textContent);
    // 每抽净变化 = 中的憨豆 − 单抽消耗。这一轮每次中 100 憨豆，所以是 −1,900/抽。
    check('面板余额按「扣消耗 + 中奖回血」结算',
        d.getElementById('bean-balance').textContent === (1234567 - 6000 + 300).toLocaleString(),
        d.getElementById('bean-balance').textContent);
    check('最多可抽随之减少到 614',
        d.getElementById('max-possible').textContent === '614',
        d.getElementById('max-possible').textContent);

    // 页面自己把余额改了（比如刷新后），应当重新采信 DOM
    d.querySelector('.bean-number').textContent = '900000.0';
    d.getElementById('view-mode').dispatchEvent(new w.Event('change'));
    await sleep(50);
    d.getElementById('set-max-possible').click();
    check('DOM 值变化后重新采信',
        d.getElementById('bean-balance').textContent === '900,000',
        d.getElementById('bean-balance').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[13] 大奖全屏庆祝');
{
    // 按官方爆率判定：VIP 0.02% 和 780,000 憨豆 0.11% 够格，
    // 邀请 0.38% 和 5,000 憨豆 15.07% 不够格。
    const cases = [
        { text: '魔力 780000 ', jackpot: true, why: '780,000 憨豆（0.11%）' },
        { text: 'VIP 7 Day(s)', jackpot: true, why: 'VIP（0.02%）' },
        { text: '邀请 1 ', jackpot: false, why: '邀请（0.38%）' },
        { text: '魔力 5000 ', jackpot: false, why: '5,000 憨豆（15.07%）' }
    ];

    for (const item of cases) {
        const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
        const w = dom.window;
        w.fetch = async () => ({
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: item.text } })
        });

        await run(dom);
        const d = w.document;
        d.getElementById('lottery-interval').value = '3';
        d.getElementById('max-lottery-count').value = '1';
        d.getElementById('start-lottery').click();
        await sleep(1200);

        const jackpotShown = !!d.querySelector('.hh-jackpot-overlay');
        const normalShown = !!d.querySelector('.hh-win-overlay');

        check(`${item.why} → ${item.jackpot ? '全屏庆祝' : '普通动画'}`,
            jackpotShown === item.jackpot && normalShown === !item.jackpot,
            `jackpot=${jackpotShown} normal=${normalShown}`);

        if (item.jackpot) {
            check(`  ${item.why} 面板上打了大奖日志`,
                Array.from(d.querySelectorAll('#lottery-log div'))
                    .some(el => el.textContent.includes('大奖')),
                '未找到大奖日志');
            check(`  ${item.why} 遮罩里带奖品文案`,
                d.querySelector('.hh-jackpot-prize')?.textContent.includes(item.text.trim()),
                d.querySelector('.hh-jackpot-prize')?.textContent);
            check(`  ${item.why} 礼花已生成`,
                d.querySelectorAll('.hh-firework').length > 0,
                d.querySelectorAll('.hh-firework').length);
        }
    }
}

/* ---------------------------------------------------------------- */
console.log('\n[14] 读不到奖池时大奖判定退回硬规则');
{
    // 没有 pool script，isJackpot 走 VIP / 十万憨豆 的兜底分支
    const dom = makeDom();
    const w = dom.window;
    w.fetch = async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 780000 ' } })
    });

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await sleep(1200);

    check('无奖池时 780,000 憨豆仍判为大奖',
        !!d.querySelector('.hh-jackpot-overlay'), '未触发');
    check('无奖池时不渲染官方爆率',
        d.querySelectorAll('#detail-list .hh-row-official').length === 0,
        d.querySelectorAll('#detail-list .hh-row-official').length);
}

/* ---------------------------------------------------------------- */
console.log('\n[15] 关掉中奖动画后大奖也不弹');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;
    w.fetch = async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 780000 ' } })
    });

    await run(dom);
    const d = w.document;
    d.getElementById('toggle-animation').click();

    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await sleep(1200);

    check('动画关闭时没有全屏遮罩', !d.querySelector('.hh-jackpot-overlay'));
    check('但仍然记进了统计',
        d.getElementById('draw-count').textContent === '1',
        d.getElementById('draw-count').textContent);
    check('也仍然打了大奖日志',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('大奖')),
        '未找到大奖日志');
}

/* ---------------------------------------------------------------- */
console.log('\n[16] 一抽到底');
{
    // 余额 20,000、单抽 2,000、保留 6,000，每次都中 100 憨豆（几乎不回血）
    // → 大约抽到余额剩 6,000 出头就该停，而不是抽满「最大抽奖次数」10 次
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '20000' });
    const w = dom.window;

    let calls = 0;
    w.fetch = async url => {
        // 余额校准会去拉 lucky.php，这里回一个不带 .bean-number 的空页面，
        // 让脚本继续用本地估算，把一抽到底的停止条件单独测出来
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        calls++;
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;

    d.getElementById('drain-mode').checked = true;
    d.getElementById('drain-mode').dispatchEvent(new w.Event('change'));

    check('勾选后最大次数输入被置灰',
        d.getElementById('max-lottery-count').disabled === true);
    check('勾选后提示可见',
        d.getElementById('drain-hint').classList.contains('is-on'));

    d.getElementById('reserve-beans').value = '6000';
    d.getElementById('reserve-beans').dispatchEvent(new w.Event('change'));
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '10';

    d.getElementById('start-lottery').click();
    check('状态栏显示一抽到底',
        d.getElementById('lottery-status').textContent.includes('一抽到底'),
        d.getElementById('lottery-status').textContent);

    await untilStopped(d);

    // 每抽净减 1,900，从 20,000 抽到「再抽一次就跌破 6,000」
    // → 停在余额 7,650（再抽会剩 5,750 < 6,000），共 7 抽
    check(`抽了 7 次而不是最大次数 10 次（实际 ${calls}）`, calls === 7, `实际 ${calls}`);
    check('已停止', d.getElementById('lottery-status').textContent === '已停止');
    check('停止原因是一抽到底完成',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('一抽到底完成')),
        '未找到完成日志');
    check('余额停在保留线之上',
        Number(d.getElementById('bean-balance').textContent.replace(/,/g, '')) >= 6000,
        d.getElementById('bean-balance').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[17] 余额随中奖回血（魔力就是憨豆）');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '10000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 5000 ' } })
        };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '0.5';
    d.getElementById('max-lottery-count').value = '2';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 20000);

    // 10,000 - 2×2,000 + 2×5,000 = 16,000
    check('中的憨豆当场加回余额',
        d.getElementById('bean-balance').textContent === '16,000',
        d.getElementById('bean-balance').textContent);
    check('校准状态显示是估算值',
        d.getElementById('balance-freshness').textContent.includes('估算'),
        d.getElementById('balance-freshness').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[18] 手动校准余额');
{
    const dom = makeDom({ useBean: '每次消耗憨豆： 2000', balance: '10000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            // 服务端的权威值和本地估算不一样
            return {
                ok: true, status: 200,
                text: async () => '<html><body><div class="bean-number">88888.0</div></body></html>'
            };
        }
        return { ok: false, status: 500, text: async () => '' };
    };

    await run(dom);
    const d = w.document;
    check('初始读的是页面上的值',
        d.getElementById('bean-balance').textContent === '10,000',
        d.getElementById('bean-balance').textContent);

    d.getElementById('refresh-balance').click();
    await sleep(600);

    check('校准后采用服务端值',
        d.getElementById('bean-balance').textContent === '88,888',
        d.getElementById('bean-balance').textContent);
    check('校准后状态是已校准',
        d.getElementById('balance-freshness').textContent === '已校准',
        d.getElementById('balance-freshness').textContent);
    check('最多可抽随之更新',
        d.getElementById('max-possible').textContent === '44',
        d.getElementById('max-possible').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[19] 备份导出与导入');
{
    const dom = makeDom();
    const w = dom.window;

    // jsdom 的 Blob 没有 .text()，包一层把写进去的内容截下来
    const NativeBlob = w.Blob;
    let blobParts = null, blobType = null;
    w.Blob = function (parts, options) {
        blobParts = parts;
        blobType = options?.type;
        return new NativeBlob(parts, options);
    };
    w.URL.createObjectURL = () => 'blob:stub';

    const seed = {
        version: 4, draws: 10, cost: 20000,
        gains: { beans: 3000, magic: 0, invite: 1, rainbow: 0, vip: 0, makeup: 0, upload: 0 },
        prizes: {
            beans: { count: 9, value: 3000, tiers: { '500 憨豆': 9 } },
            invite: { count: 1, value: 1, tiers: { '1 邀请': 1 } }
        },
        raw: { '魔力 500': 9 }
    };
    w.localStorage.setItem('hhanclub_lottery_stats_v4', JSON.stringify(seed));

    await run(dom);
    const d = w.document;

    d.getElementById('backup-stats').click();
    await sleep(80);

    check('点备份产生了 JSON blob', blobType === 'application/json', String(blobType));
    const payload = JSON.parse(blobParts[0]);
    check('备份带识别标记', payload.kind === 'hhclub-lottery-backup', payload.kind);
    check('备份含历史统计 10 抽', payload.total.draws === 10, payload.total.draws);
    check('备份含分奖项明细', payload.total.prizes.beans.count === 9);

    // 真正走一遍 importStats：拦下它 new 出来的 file input，塞个假文件再触发 change
    const backupJson = blobParts[0];
    const nativeCreate = d.createElement.bind(d);
    let picker = null;
    d.createElement = tag => {
        const el = nativeCreate(tag);
        if (tag === 'input') picker = el;
        return el;
    };

    // mode: 'merge' | 'replace' | 'cancel'，对应弹窗上的三个按钮
    const feed = async (json, mode) => {
        picker = null;
        d.getElementById('import-stats').click();
        Object.defineProperty(picker, 'files', {
            configurable: true,
            get: () => [{ name: 'backup.json', text: async () => json }]
        });
        picker.dispatchEvent(new w.Event('change'));
        await sleep(150);

        const dialog = d.querySelector('.hh-modal-overlay');
        if (!dialog) return null;

        const button = dialog.querySelector(`[data-mode="${mode}"]`);
        button.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        await sleep(150);
        return button.textContent;
    };

    // 合并：把同一份备份再叠加一次
    const mergeLabel = await feed(backupJson, 'merge');
    check('弹窗把合并后的总抽数算给用户看',
        /共 20 抽/.test(mergeLabel || ''), mergeLabel);
    check('选完之后弹窗关掉了', !d.querySelector('.hh-modal-overlay'));
    let stored = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('合并导入：抽数相加为 20', stored.draws === 20, stored.draws);
    check('合并导入：消耗相加为 40,000', stored.cost === 40000, stored.cost);
    check('合并导入：档位次数相加为 18',
        stored.prizes.beans.tiers['500 憨豆'] === 18, stored.prizes.beans.tiers['500 憨豆']);
    check('合并导入：兜底文案相加为 18', stored.raw['魔力 500'] === 18, stored.raw['魔力 500']);

    d.getElementById('view-mode').value = 'total';
    d.getElementById('view-mode').dispatchEvent(new w.Event('change'));
    await sleep(50);
    check('合并后面板同步刷新',
        d.getElementById('draw-count').textContent === '20',
        d.getElementById('draw-count').textContent);

    // 覆盖：回到备份里的 10 抽
    await feed(backupJson, 'replace');
    stored = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('覆盖导入：抽数回到 10', stored.draws === 10, stored.draws);
    check('覆盖导入：档位次数回到 9',
        stored.prizes.beans.tiers['500 憨豆'] === 9, stored.prizes.beans.tiers['500 憨豆']);

    // 取消必须真的什么都不做
    await feed(backupJson, 'cancel');
    stored = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('取消导入不改动任何数据', stored.draws === 10, stored.draws);
    check('取消打了对应日志',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('已取消导入')),
        '未找到取消日志');

    // 垃圾文件不能把已有数据搞坏
    await feed('{ not json', 'merge');
    stored = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('非法 JSON 被拒绝且不动已有数据', stored.draws === 10, stored.draws);
    check('非法 JSON 打了错误日志',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('不是合法 JSON')),
        '未找到错误日志');

    await feed(JSON.stringify({ hello: 'world' }), 'merge');
    stored = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('认不出的结构被拒绝', stored.draws === 10, stored.draws);

    d.createElement = nativeCreate;
}

/* ---------------------------------------------------------------- */
console.log('\n[20] 面板底部横幅已移除');
{
    const dom = makeDom();
    await run(dom);
    const d = dom.window.document;

    check('没有 .hh-footer 节点', !d.querySelector('#lottery-control-panel .hh-footer'));
    check('面板里不再出现 4TH ANNIVERSARY 底栏文案',
        !d.getElementById('lottery-control-panel').textContent.includes('HHCLUB 4TH ANNIVERSARY'));
}

/* ---------------------------------------------------------------- */
console.log('\n[21] 校准值必须压过过期的页面数字');
{
    // 这条是线上实测逼出来的：校准拿到服务端值之后，紧接着的
    // updateBalanceDisplay() 会重新读 DOM，一旦 DOM 数字和上次记录的不同，
    // 「DOM 变了就采信 DOM」的规则就会把刚校准好的值冲掉。
    const dom = makeDom({ useBean: '每次消耗憨豆： 2000', balance: '10000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return {
                ok: true, status: 200,
                text: async () => '<html><body><div class="bean-number">1741668.0</div></body></html>'
            };
        }
        return { ok: false, status: 500, text: async () => '' };
    };

    await run(dom);
    const d = w.document;

    // 页面上的数字换成另一个过期值（模拟站点自己动过、或者别处改过）
    d.querySelector('.bean-number').textContent = '12345.0';

    d.getElementById('refresh-balance').click();
    await sleep(700);

    check('校准后显示服务端值而不是页面上的旧数字',
        d.getElementById('bean-balance').textContent === '1,741,668',
        d.getElementById('bean-balance').textContent);

    // 「按余额设置」会走一遍 updateBalanceDisplay，正好用来确认校准值稳得住
    d.getElementById('set-max-possible').click();
    await sleep(120);
    d.getElementById('set-max-possible').click();
    await sleep(120);

    check('后续刷新不会把校准值冲回去',
        d.getElementById('bean-balance').textContent === '1,741,668',
        d.getElementById('bean-balance').textContent);
    check('最多可抽按校准值算',
        d.getElementById('max-possible').textContent === '870',
        d.getElementById('max-possible').textContent);

    // 但页面数字如果之后又变了（比如用户刷新了页面），仍然要重新采信
    d.querySelector('.bean-number').textContent = '500000.0';
    d.getElementById('set-max-possible').click();
    await sleep(120);

    check('DOM 之后再变化时仍然重新采信',
        d.getElementById('bean-balance').textContent === '500,000',
        d.getElementById('bean-balance').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[22] 站点调整爆率后奖池会跟着刷新');
{
    // 站点把 780,000 憨豆的爆率从 0.11% 调到 0.30%，
    // 理论盈亏率和大奖判定都该跟着变
    const TUNED = REAL_POOL.map(item =>
        (item.typeText === '魔力' && item.amountText === '780000 ')
            ? { ...item, probability_real: '0.0030' }
            : item);

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '100000' });
    const w = dom.window;

    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            // 抓回来的页面带的是调整后的奖池
            return {
                ok: true, status: 200,
                text: async () => `<html><body>
                    <div class="bean-number">100000.0</div>
                    <script>let prizes = ${JSON.stringify(TUNED)};</script>
                </body></html>`
            };
        }
        return { ok: false, status: 500, text: async () => '' };
    };

    await run(dom);
    const d = w.document;

    d.getElementById('refresh-balance').click();
    await until(() => Array.from(d.querySelectorAll('#lottery-log div'))
        .some(el => el.textContent.includes('调整了奖池爆率')), 5000);

    check('日志提示了爆率变动',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('调整了奖池爆率')),
        '未找到爆率变动日志');

    // 抽一注 780,000，档位行上的官方爆率应该已经是调整后的 0.30%
    w.fetch = async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 780000 ' } })
    });
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await untilStopped(d);

    check('明细里的官方爆率换成了调整后的 0.30%',
        Array.from(d.querySelectorAll('#detail-list .hh-tier-rate'))
            .some(el => el.textContent.includes('官方 0.30%')),
        Array.from(d.querySelectorAll('#detail-list .hh-tier-rate')).map(el => el.textContent).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[23] 爆率没变时不重复打扰');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '100000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return {
                ok: true, status: 200,
                text: async () => `<html><body>
                    <div class="bean-number">100000.0</div>
                    <script>let prizes = ${JSON.stringify(REAL_POOL)};</script>
                </body></html>`
            };
        }
        return { ok: false, status: 500, text: async () => '' };
    };

    await run(dom);
    const d = w.document;

    d.getElementById('refresh-balance').click();
    await sleep(600);
    d.getElementById('refresh-balance').click();
    await sleep(600);

    check('奖池没变就不打爆率变动日志',
        !Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('调整了奖池爆率')),
        '不该出现的日志');
    check('也不会误报站点撤掉了爆率',
        !Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('不再公布')),
        '不该出现的日志');
}

/* ---------------------------------------------------------------- */
console.log('\n[24] 抓回来的页面读不到奖池时保留原有爆率');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '100000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            // 站点改版 / 返回了不带奖池的页面
            return {
                ok: true, status: 200,
                text: async () => '<html><body><div class="bean-number">777777.0</div></body></html>'
            };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;

    // 先抽一注，明细里才有行可看
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await untilStopped(d);

    d.getElementById('refresh-balance').click();
    await until(() => d.getElementById('bean-balance').textContent === '777,777', 5000);

    check('余额照常校准', d.getElementById('bean-balance').textContent === '777,777',
        d.getElementById('bean-balance').textContent);
    check('奖池读不到时沿用原有爆率，不清空',
        Array.from(d.querySelectorAll('#detail-list .hh-row-official'))
            .some(el => el.textContent === '官方 83.0%'),
        Array.from(d.querySelectorAll('#detail-list .hh-row-official')).map(el => el.textContent).join(' | '));
    check('也不会误报站点撤掉了爆率',
        !Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('不再公布')),
        '不该出现的日志');
}

/* ---------------------------------------------------------------- */
console.log('\n[25] 挂机期间站点调价：跟进但不打断');
{
    // 一抽到底是挂机用的。中途站点把单抽消耗从 2,000 调到 4,000，
    // 脚本要跟上新成本，但不能弹窗、不能停。
    const TUNED_POOL = REAL_POOL.map(item =>
        (item.typeText === '魔力' && item.amountText === '780000 ')
            ? { ...item, probability_real: '0.0030' }
            : item);

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '30000' });
    const w = dom.window;

    // 任何弹窗都算打断挂机
    let interrupted = 0;
    w.confirm = () => { interrupted++; return true; };
    w.alert = () => { interrupted++; };

    let draws = 0;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return {
                ok: true, status: 200,
                text: async () => `<html><body>
                    <div class="bean-number">${30000 - draws * 1900}.0</div>
                    <div class="use-bean">每次消耗憨豆： 4000</div>
                    <script>let prizes = ${JSON.stringify(TUNED_POOL)};</script>
                </body></html>`
            };
        }
        draws++;
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;

    check('起步用页面上的 2,000', d.getElementById('single-cost').textContent === '2,000',
        d.getElementById('single-cost').textContent);

    d.getElementById('drain-mode').checked = true;
    d.getElementById('drain-mode').dispatchEvent(new w.Event('change'));
    d.getElementById('reserve-beans').value = '12000';
    d.getElementById('reserve-beans').dispatchEvent(new w.Event('change'));
    // 验的是调价能被跟进且不打断循环，间隔用下限
    d.getElementById('lottery-interval').value = '0.5';
    d.getElementById('start-lottery').click();

    // 第一次校准发生在余额估算逼近保留线时，会带回新的成本和爆率
    await until(() => d.getElementById('single-cost').textContent === '4,000', 90000);
    check('跟进了站点的新单次消耗 4,000',
        d.getElementById('single-cost').textContent === '4,000',
        d.getElementById('single-cost').textContent);

    await untilStopped(d);

    check('挂机全程没有弹出任何对话框', interrupted === 0, `弹了 ${interrupted} 次`);
    check('调价日志有记录',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('单次消耗')),
        '未找到调价日志');
    check('爆率变动日志也有记录',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('调整了奖池爆率')),
        '未找到爆率日志');
    check('是按一抽到底的条件停的，不是被打断的',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('一抽到底完成')),
        '未按保留线停止');

    // 用新成本判断，余额必须停在保留线之上
    const finalBalance = Number(d.getElementById('bean-balance').textContent.replace(/,/g, ''));
    check(`按新成本守住保留线 12,000（余额 ${finalBalance}）`,
        finalBalance >= 12000, `实际 ${finalBalance}`);
}

/* ---------------------------------------------------------------- */
console.log('\n[26] 单次消耗没变时不打扰');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '100000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return {
                ok: true, status: 200,
                text: async () => `<html><body>
                    <div class="bean-number">100000.0</div>
                    <div class="use-bean">每次消耗憨豆： 2000</div>
                </body></html>`
            };
        }
        return { ok: false, status: 500, text: async () => '' };
    };

    await run(dom);
    const d = w.document;

    d.getElementById('refresh-balance').click();
    await sleep(600);

    check('消耗没变就不打日志',
        !Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('单次消耗')),
        '不该出现的日志');
    check('单次消耗保持 2,000',
        d.getElementById('single-cost').textContent === '2,000',
        d.getElementById('single-cost').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[27] 站点撤掉 probability_real 时改用原始权重');
{
    // 线上 2026-08-19 的奖池：只剩 probability（原始权重），没有算好的概率
    const WEIGHT_POOL = [
        { typeText: '彩虹 ID', amountText: '7 Day(s)', probability: 400 },
        { typeText: '魔力', amountText: '780000 ', probability: 14 },
        { typeText: '魔力', amountText: '5000 ', probability: 2039 },
        { typeText: 'VIP', amountText: '7 Day(s)', probability: 3 },
        { typeText: '魔力', amountText: '100 ', probability: 3961 },
        { typeText: '补签卡', amountText: '1 ', probability: 800 },
        { typeText: '魔力', amountText: '2000 ', probability: 3000 },
        { typeText: '上传量', amountText: '2 GB', probability: 800 },
        { typeText: '魔力', amountText: '1000 ', probability: 3500 },
        { typeText: '上传量', amountText: '5 GB', probability: 200 },
        { typeText: '邀请', amountText: '1 ', probability: 50 }
    ];

    const dom = makeDom({ pool: WEIGHT_POOL, useBean: '每次消耗憨豆： 2000', balance: '100000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;

    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await untilStopped(d);

    const official = Array.from(d.querySelectorAll('#detail-list .hh-row-official'));
    check('官方爆率照常显示，不是 0.00%',
        official.length === 1 && official[0].textContent === '官方 84.7%',
        official.map(el => el.textContent).join(' | '));

    const tierRates = Array.from(d.querySelectorAll('#detail-list .hh-tier-rate'));
    check('档位爆率也配得上（100 憨豆 26.82%）',
        tierRates.some(el => el.textContent.includes('官方 26.82%')),
        tierRates.map(el => el.textContent).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[28] 两个爆率字段都没有时整块降级，不摆 0.00%');
{
    const BLIND_POOL = REAL_POOL.map(({ typeText, amountText }) => ({ typeText, amountText }));

    const dom = makeDom({ pool: BLIND_POOL, useBean: '每次消耗憨豆： 2000', balance: '100000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;

    check('日志说明了爆率为什么没了',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('不再公布')),
        '未找到说明日志');

    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await untilStopped(d);

    check('类别行不显示官方爆率',
        d.querySelectorAll('#detail-list .hh-row-official').length === 0,
        Array.from(d.querySelectorAll('#detail-list .hh-row-official')).map(el => el.textContent).join(' | '));
    const blindTiers = Array.from(d.querySelectorAll('#detail-list .hh-tier-rate'));
    check('档位行不显示官方爆率',
        blindTiers.every(el => !el.textContent.includes('官方')),
        blindTiers.map(el => el.textContent).join(' | '));
    check('但档位的实测占比照样显示',
        blindTiers.length === 1 && /^实测 \d+\.\d\d%$/.test(blindTiers[0].textContent.trim()),
        blindTiers.map(el => el.textContent).join(' | '));
    check('实测数据照常统计',
        d.getElementById('draw-count').textContent === '1',
        d.getElementById('draw-count').textContent);
}


/* 收件箱页面夹具：照站点的 grid 行结构渲染，外加那个翻页下拉框 —— 脚本靠它读总页数 */
function mailPage(items, pageCount = 1) {
    const rows = items.map(item => `
        <div class="grid grid-cols-[10%_5%_60%_10%_15%]">
            <div class="flex flex-row act-checkbox">
                <input type="checkbox" name="messages[]" value="${item.id}">
            </div>
            <div><img src="icon-unread.svg"></div>
            <div><a href="messages.php?action=viewmessage&id=${item.id}">${item.subject}</a></div>
            <div>系统</div>
            <div>2026-08-19 11:35:52</div>
        </div>`).join('');
    const pager = `<select onchange="switchPage(this)">${
        Array.from({ length: Math.max(1, pageCount) }, (_, n) => `<option value="${n}">${n + 1}</option>`).join('')
    }</select>`;
    return `<html><body><form method="post" action="messages.php">
        <input type="hidden" name="action" value="moveordel">${pager}${rows}</form></body></html>`;
}

const lotteryMail = (from, count) =>
    Array.from({ length: count }, (_, i) => ({ id: String(from + i), subject: '幸运大转盘 中奖通知' }));

/* 一个会真的少信的收件箱：删掉的信从后续分页里消失。
   pageSize 可调 —— 站点上每页显示多少封是用户自己设的，默认 100，见过 10 的。 */
function makeMailbox(items, pageSize = 100) {
    let inbox = [...items];
    let size = pageSize;
    return {
        setPageSize(n) { size = n; },
        get pageCount() { return Math.max(1, Math.ceil(inbox.length / size)); },
        page(n) { return inbox.slice(n * size, (n + 1) * size); },
        remove(ids) { inbox = inbox.filter(item => !ids.includes(item.id)); },
        add(item) { inbox = [item, ...inbox]; },
        get all() { return inbox; }
    };
}

/* 把一个 makeMailbox 接到 window.fetch 上，顺带记账 */
function serveMailbox(w, box, { onDelete } = {}) {
    const log = { deleted: [], pageHits: [], posts: 0, actions: [], flags: [] };
    w.fetch = async (url, init = {}) => {
        const target = String(url);
        if (init.method === 'POST') {
            log.posts++;
            log.actions.push(init.body.get('action'));
            log.flags.push(init.body.get('delete'));

            const ids = init.body.getAll('messages[]');
            log.deleted.push(...ids);
            box.remove(ids);
            onDelete?.(log.posts);
            return { ok: true, status: 200, text: async () => '' };
        }
        if (target.includes('messages.php')) {
            const page = Number(new URL(target, 'https://hhanclub.net').searchParams.get('page'));
            log.pageHits.push(page);
            return { ok: true, status: 200, text: async () => mailPage(box.page(page), box.pageCount) };
        }
        return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
    };
    return log;
}

/* ---------------------------------------------------------------- */
console.log('\n[29] 只删抽奖通知：别的信一封不碰，中途新到的也扫干净');
{
    const KEEP = [
        { id: '9001', subject: '种子被删除' },
        { id: '9002', subject: '种子被删除' },
        { id: '9003', subject: '憨豆 改变' }
    ];
    const box = makeMailbox([
        ...lotteryMail(1000, 100),
        ...lotteryMail(2000, 98), KEEP[0], KEEP[1],
        ...lotteryMail(3000, 15), KEEP[2]
    ]);
    const TOTAL_LOTTERY = 100 + 98 + 15;

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    // 第一批删完的当口又中了一次奖，新通知这时才进收件箱 ——
    // 它不在扫描时的 id 清单里，只能靠扫尾那一步收掉
    const log = serveMailbox(w, box, {
        onDelete: posts => { if (posts === 1) box.add({ id: '4242', subject: '幸运大转盘 中奖通知' }); }
    });

    await run(dom);
    const d = w.document;

    d.getElementById('purge-mail').click();
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="lottery"]'), 10000);

    const modalText = (d.querySelector('.hh-modal-text')?.textContent || '').replace(/\s+/g, ' ').trim();
    check(`确认框写明收件箱共 ${TOTAL_LOTTERY + 3} 封`, modalText.includes(String(TOTAL_LOTTERY + 3)), modalText);
    check(`确认框写明抽奖通知 ${TOTAL_LOTTERY} 封`, modalText.includes(String(TOTAL_LOTTERY)), modalText);
    check('确认框给了「全部删除」这个选项',
        !!d.querySelector('.hh-modal-overlay [data-mode="all"]'), '没有全部删除按钮');

    d.querySelector('.hh-modal-overlay [data-mode="lottery"]').click();
    await until(() => log.deleted.includes('4242'), 10000);
    await sleep(400);

    check('每次提交都带 action=moveordel',
        log.actions.every(a => a === 'moveordel'), log.actions.join(','));
    check('每次提交按的都是删除键',
        log.flags.every(f => f === '删除'), log.flags.join(','));
    check('先按翻页框翻完三页，删完再补扫第一页到干净',
        log.pageHits.join(',') === '0,1,2,0,0', log.pageHits.join(','));
    check(`删掉 ${TOTAL_LOTTERY} 封 + 中途新到的 1 封`,
        log.deleted.length === TOTAL_LOTTERY + 1, `实际 ${log.deleted.length}`);
    check('中途新到的那封也删了', log.deleted.includes('4242'), '没删掉');
    check('一封非抽奖通知都没被删',
        KEEP.every(item => !log.deleted.includes(item.id)),
        KEEP.filter(item => log.deleted.includes(item.id)).map(item => item.subject).join(' | '));
    check('收件箱里只剩那 3 封该留的',
        box.all.length === 3 && box.all.every(item => !item.subject.includes('幸运大转盘')),
        box.all.map(item => item.subject).join(' | '));
    check('日志写明了删了多少、留了多少',
        Array.from(d.querySelectorAll('#lottery-log div'))
            .some(el => el.textContent.includes('已删除') && el.textContent.includes('原样保留')),
        '未找到结果日志');
}

/* ---------------------------------------------------------------- */
console.log('\n[30] 每页只显示 10 封时也要翻完整个收件箱');
{
    // 每页显示多少封是用户在站点设置里自己定的。早先的实现写死「不满 100 封
    // 就是最后一页」，每页 10 封的人翻一页就以为到底了，第 11 封往后全删不掉。
    const KEEP = [
        { id: '9001', subject: '种子被删除' },
        { id: '9002', subject: '憨豆 改变' }
    ];
    const box = makeMailbox([...lotteryMail(1000, 40), ...KEEP], 10);

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;
    const log = serveMailbox(w, box);

    await run(dom);
    const d = w.document;

    d.getElementById('purge-mail').click();

    // 5 页会先弹「要不要改成每页 100」，这里选不改 —— 就是要验证不改也能翻完
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="keep"]'), 10000);
    d.querySelector('.hh-modal-overlay [data-mode="keep"]').click();

    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="lottery"]'), 10000);

    const modalText = (d.querySelector('.hh-modal-text')?.textContent || '').replace(/\s+/g, ' ').trim();
    check('确认框认出了全部 40 封抽奖通知', modalText.includes('40'), modalText);

    check('扫描翻了全部 5 页，不是只翻第一页',
        log.pageHits.slice(0, 5).join(',') === '0,1,2,3,4', log.pageHits.join(','));
    check('探测页数用的第一页被复用，没重复拉',
        log.pageHits.filter(page => page === 0).length === 1, log.pageHits.join(','));

    d.querySelector('.hh-modal-overlay [data-mode="lottery"]').click();
    await until(() => log.deleted.length >= 40, 10000);
    await sleep(400);

    check('40 封抽奖通知一封不剩', log.deleted.length === 40, `实际 ${log.deleted.length}`);
    check('第 11 封往后的也删掉了',
        log.deleted.includes('1010') && log.deleted.includes('1039'), '有漏网的');
    check('两封该留的还在',
        box.all.length === 2 && KEEP.every(item => !log.deleted.includes(item.id)),
        box.all.map(item => item.subject).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[31] 取消确认框时一封都不删');
{
    const box = makeMailbox(lotteryMail(5000, 12));

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;
    const log = serveMailbox(w, box);

    await run(dom);
    const d = w.document;

    d.getElementById('purge-mail').click();
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="cancel"]'), 10000);
    d.querySelector('.hh-modal-overlay [data-mode="cancel"]').click();
    await sleep(400);

    check('取消后没有发出任何删除请求', log.posts === 0, `实际 ${log.posts}`);
    check('收件箱一封没少', box.all.length === 12, `实际 ${box.all.length}`);
    check('日志说明了已取消',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('一封都没删')),
        '未找到取消日志');
    check('按钮恢复可用',
        d.getElementById('purge-mail').disabled === false
        && d.getElementById('purge-mail').textContent.includes('立即清空'),
        d.getElementById('purge-mail').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[32] 全部删除：连别的站内信一起清，但不补扫');
{
    const box = makeMailbox([
        ...lotteryMail(1000, 8),
        { id: '9001', subject: '种子被删除' },
        { id: '9002', subject: '憨豆 改变' }
    ]);

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;
    // 删的当口又到了一封正经站内信，全部删除模式不该把它带走
    const log = serveMailbox(w, box, {
        onDelete: () => box.add({ id: '7777', subject: '种子被删除' })
    });

    await run(dom);
    const d = w.document;

    d.getElementById('purge-mail').click();
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="all"]'), 10000);
    d.querySelector('.hh-modal-overlay [data-mode="all"]').click();
    await until(() => log.deleted.length >= 10, 10000);
    await sleep(400);

    check('10 封全删了', log.deleted.length === 10, `实际 ${log.deleted.length}`);
    check('非抽奖通知这次也删了',
        log.deleted.includes('9001') && log.deleted.includes('9002'), log.deleted.join(','));
    check('一页装得下就只读一页', log.pageHits.join(',') === '0', log.pageHits.join(','));
    check('全部删除不补扫，删除期间新到的正经站内信没被带走',
        !log.deleted.includes('7777') && box.all.some(item => item.id === '7777'),
        box.all.map(item => item.id).join(','));
    check('日志说的是清空收件箱',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('已清空收件箱')),
        '未找到结果日志');
}

/* ---------------------------------------------------------------- */
console.log('\n[33] 自动删站内信：关着不动，开着一路清到第一页干净');
{
    // 每页 10 封，但两次校准之间会攒 25 封 —— 一次只清一页永远追不上，
    // 所以自动清理必须循环清到第一页没有抽奖通知为止
    const KEEP = { id: '9001', subject: '种子被删除' };
    const box = makeMailbox([...lotteryMail(7000, 30), KEEP], 10);

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '10000000' });
    const w = dom.window;

    const deleted = [];
    const pageHits = [];
    w.fetch = async (url, init = {}) => {
        const target = String(url);
        if (init.method === 'POST' && target.includes('messages.php')) {
            const ids = init.body.getAll('messages[]');
            deleted.push(...ids);
            box.remove(ids);
            return { ok: true, status: 200, text: async () => '' };
        }
        if (target.includes('messages.php')) {
            const page = Number(new URL(target, 'https://hhanclub.net').searchParams.get('page'));
            pageHits.push(page);
            return { ok: true, status: 200, text: async () => mailPage(box.page(page), box.pageCount) };
        }
        if (target.includes('lucky.php')) {
            return {
                ok: true, status: 200,
                text: async () => '<html><body><div class="bean-number">10000000.0</div></body></html>'
            };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;

    check('默认不开', d.getElementById('auto-clean-mail').checked === false);

    // 26 抽才够触发一次自动清理，间隔用下限，否则光等就要一分半
    d.getElementById('lottery-interval').value = '0.5';
    d.getElementById('max-lottery-count').value = '3';
    d.getElementById('start-lottery').click();
    await untilStopped(d);

    check('没开时一次都不去读收件箱', pageHits.length === 0, pageHits.join(','));

    d.getElementById('auto-clean-mail').checked = true;
    d.getElementById('auto-clean-mail').dispatchEvent(new w.Event('change'));
    check('开关状态存进了设置',
        JSON.parse(w.localStorage.getItem('hhanclub_lottery_settings_v1')).autoCleanMail === true,
        w.localStorage.getItem('hhanclub_lottery_settings_v1'));
    check('提示文案跟着显示',
        d.getElementById('mail-hint').classList.contains('is-on'));

    d.getElementById('max-lottery-count').value = '26';
    d.getElementById('start-lottery').click();
    await until(() => deleted.length >= 30, 150000);
    await untilStopped(d, 150000);

    check('自动清理只读第一页', pageHits.every(page => page === 0), pageHits.join(','));
    check('30 封抽奖通知全清掉，没有因为一页只有 10 封就停',
        deleted.length === 30, `实际 ${deleted.length}`);
    check('自动清理也不碰其他站内信',
        !deleted.includes(KEEP.id) && box.all.length === 1, box.all.map(item => item.subject).join(' | '));
    check('日志记了一行',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('封抽奖通知')),
        '未找到清理日志');
}

/* 网站设定页夹具：照 usercp 的样子给一堆各类字段，用来验证「只改 pmnum」 */
function usercpPage(pmnum) {
    return `<html><body>
        <form action="usercp.php" method="post">
            <input type="hidden" name="action" value="tracker">
            <input type="hidden" name="type" value="save">
            <input type="checkbox" name="cat401" value="yes" checked>
            <input type="checkbox" name="cat402" value="yes">
            <input type="checkbox" name="cat403" value="yes" checked>
            <input type="checkbox" name="showcomnum" value="yes" checked>
            <input type="radio" name="timetype" value="added">
            <input type="radio" name="timetype" value="last" checked>
            <select name="stylesheet">
                <option value="1">默认</option><option value="7" selected>HHan</option>
            </select>
            <select name="fontsize">
                <option value="small">小</option><option value="medium" selected>中</option>
            </select>
            <input type="text" name="pmnum" value="${pmnum}">
            <input type="text" name="sbnum" value="70">
            <input type="text" name="torrentsperpage" value="0">
            <button type="submit">保存</button>
        </form>
    </body></html>`;
}

/* ---------------------------------------------------------------- */
console.log('\n[34] 每页条数太小时提议改站点设置，且只改这一项');
{
    const KEEP = { id: '9001', subject: '种子被删除' };
    const box = makeMailbox([...lotteryMail(1000, 44), KEEP], 10);   // 45 封 / 每页 10 = 5 页

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    let pmnum = 10;
    let savedBody = null;
    const pageHits = [];
    const deleted = [];

    w.fetch = async (url, init = {}) => {
        const target = String(url);

        if (target.includes('usercp.php') && init.method === 'POST') {
            savedBody = init.body;
            pmnum = Number(init.body.get('pmnum')) || pmnum;
            box.setPageSize(pmnum);
            return { ok: true, status: 200, text: async () => '' };
        }
        if (target.includes('usercp.php')) {
            return { ok: true, status: 200, text: async () => usercpPage(pmnum) };
        }
        if (init.method === 'POST') {
            const ids = init.body.getAll('messages[]');
            deleted.push(...ids);
            box.remove(ids);
            return { ok: true, status: 200, text: async () => '' };
        }
        if (target.includes('messages.php')) {
            const page = Number(new URL(target, 'https://hhanclub.net').searchParams.get('page'));
            pageHits.push(page);
            return { ok: true, status: 200, text: async () => mailPage(box.page(page), box.pageCount) };
        }
        return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
    };

    await run(dom);
    const d = w.document;

    d.getElementById('purge-mail').click();
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="bump"]'), 10000);

    const askText = (d.querySelector('.hh-modal-text')?.textContent || '').replace(/\s+/g, ' ').trim();
    check('提示里写明了当前每页 10 封、要翻 5 页',
        askText.includes('10') && askText.includes('5'), askText);

    d.querySelector('.hh-modal-overlay [data-mode="bump"]').click();
    await until(() => !!savedBody, 10000);

    check('提交的是 action=tracker / type=save',
        savedBody.get('action') === 'tracker' && savedBody.get('type') === 'save',
        `${savedBody.get('action')} / ${savedBody.get('type')}`);
    check('pmnum 改成了 100', savedBody.get('pmnum') === '100', savedBody.get('pmnum'));
    check('pmnum 只提交一次，不是追加',
        savedBody.getAll('pmnum').length === 1, `实际 ${savedBody.getAll('pmnum').length} 个`);
    check('勾着的复选框原样回填',
        savedBody.getAll('cat401').join() === 'yes'
        && savedBody.getAll('cat403').join() === 'yes'
        && savedBody.getAll('showcomnum').join() === 'yes',
        [...savedBody.keys()].join(','));
    check('没勾的复选框不会被凭空勾上',
        !savedBody.has('cat402'), 'cat402 被提交了');
    check('单选按当前选中的那个提交',
        savedBody.get('timetype') === 'last', savedBody.get('timetype'));
    check('下拉框按当前选中项提交',
        savedBody.get('stylesheet') === '7' && savedBody.get('fontsize') === 'medium',
        `${savedBody.get('stylesheet')} / ${savedBody.get('fontsize')}`);
    check('其余文本框原样回填',
        savedBody.get('sbnum') === '70' && savedBody.get('torrentsperpage') === '0',
        `${savedBody.get('sbnum')} / ${savedBody.get('torrentsperpage')}`);
    check('提交按钮不会被当成字段',
        ![...savedBody.keys()].some(k => k === ''), [...savedBody.keys()].join(','));

    check('日志报了改动结果',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('每页站内信条数已改成')),
        '未找到结果日志');

    // 改完之后按新的每页 100 封扫，44 封抽奖通知照样一封不漏
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="lottery"]'), 10000);
    d.querySelector('.hh-modal-overlay [data-mode="lottery"]').click();
    await until(() => deleted.length >= 44, 10000);
    await sleep(400);

    check('改完后按新页大小扫，44 封全删了', deleted.length === 44, `实际 ${deleted.length}`);
    check('该留的那封还在', !deleted.includes(KEEP.id) && box.all.length === 1,
        box.all.map(item => item.subject).join(' | '));

    // 问过一次就不再问
    box.add({ id: '8001', subject: '幸运大转盘 中奖通知' });
    d.getElementById('purge-mail').click();
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="lottery"]'), 10000);
    check('答过一次就不再打扰',
        !d.querySelector('.hh-modal-overlay [data-mode="bump"]'), '又弹了一次');
    d.querySelector('.hh-modal-overlay [data-mode="cancel"]').click();
    await sleep(200);
}

/* ---------------------------------------------------------------- */
console.log('\n[35] 页数不多时不提这茬');
{
    const box = makeMailbox(lotteryMail(1000, 15), 10);   // 15 封 / 每页 10 = 2 页

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    let usercpHits = 0;
    w.fetch = async (url, init = {}) => {
        const target = String(url);
        if (target.includes('usercp.php')) {
            usercpHits++;
            return { ok: true, status: 200, text: async () => usercpPage(10) };
        }
        if (init.method === 'POST') {
            box.remove(init.body.getAll('messages[]'));
            return { ok: true, status: 200, text: async () => '' };
        }
        if (target.includes('messages.php')) {
            const page = Number(new URL(target, 'https://hhanclub.net').searchParams.get('page'));
            return { ok: true, status: 200, text: async () => mailPage(box.page(page), box.pageCount) };
        }
        return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
    };

    await run(dom);
    const d = w.document;

    d.getElementById('purge-mail').click();
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="lottery"]'), 10000);

    check('只有两页时不弹改设置的提示',
        !d.querySelector('.hh-modal-overlay [data-mode="bump"]'), '弹了');
    check('也没去碰网站设定页', usercpHits === 0, `实际请求了 ${usercpHits} 次`);

    d.querySelector('.hh-modal-overlay [data-mode="cancel"]').click();
    await sleep(200);
}

/* ---------------------------------------------------------------- */
console.log('\n[36] 循环里抛异常要停下来并说一声，不能装作还在跑');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;

    // 制造一个渲染期异常：fmt() 走的就是 toLocaleString。
    // 只炸一次就自己恢复 —— 一直炸的话连 startLottery 和停机流程都进不去，
    // 测不出「循环中途抛异常」这个场景。
    const realToLocaleString = w.Number.prototype.toLocaleString;
    let armed = false;
    w.Number.prototype.toLocaleString = function (...args) {
        if (armed) {
            armed = false;
            throw new Error('渲染炸了');
        }
        return realToLocaleString.apply(this, args);
    };

    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '5';
    d.getElementById('start-lottery').click();

    // 等第一抽正常落地，再埋雷，确保炸在循环中途
    await until(() => d.getElementById('draw-count').textContent === '1', 30000);
    armed = true;

    await untilStopped(d, 30000);

    check('状态停在「已停止」，不是卡在运行中',
        d.getElementById('lottery-status').textContent === '已停止',
        d.getElementById('lottery-status').textContent);
    check('日志里报了异常原因',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('抽奖循环异常')),
        '未找到异常日志');
    check('停止按钮已置灰', d.getElementById('stop-lottery').disabled === true);
}

/* ---------------------------------------------------------------- */
console.log('\n[37] 「奖项种类」和明细里的「N 种」口径一致');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    // 导入来的数据可能带着中过 0 次的空桶（旧版本 / 手改过的备份）
    w.localStorage.setItem('hhanclub_lottery_stats_v4', JSON.stringify({
        version: 4, draws: 10, cost: 20000,
        gains: { beans: 3000, magic: 0, invite: 0, rainbow: 0, vip: 0, makeup: 0, upload: 0, rename: 0 },
        prizes: {
            beans: { count: 10, value: 3000, tiers: { '100 憨豆': 10 } },
            vip: { count: 0, value: 0, tiers: {} },
            rename: { count: 0, value: 0, tiers: {} }
        },
        raw: {}
    }));

    await run(dom);
    const d = w.document;

    d.getElementById('view-mode').value = 'total';
    d.getElementById('view-mode').dispatchEvent(new w.Event('change'));
    await sleep(150);

    const summary = d.getElementById('detail-summary').textContent;
    check('明细里只算真中过的：1 种', summary.includes('1 种'), summary);
    check('顶部「奖项种类」也是 1，不把空桶算进去',
        d.getElementById('prize-type-count').textContent === '1',
        d.getElementById('prize-type-count').textContent);
}

/* 中一注 VIP，服务端余额按 serverBalance() 给。抽奖页说明里那条规则：
   已经是 VIP 的用户中到 VIP，站点改发 1,000,000 憨豆。 */
async function drawOneVip(serverBalance) {
    const START = 500000;
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: String(START) });
    const w = dom.window;

    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return {
                ok: true, status: 200,
                text: async () => `<html><body>
                    <div class="bean-number">${serverBalance(START)}.0</div>
                    <div class="use-bean">每次消耗憨豆： 2000</div>
                </body></html>`
            };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: 'VIP 7 Day(s)' } })
        };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 30000);

    return { w, d, stats: JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4')), START };
}

/* ---------------------------------------------------------------- */
console.log('\n[38] 已是 VIP 时站点改发憨豆，要按憨豆记账');
{
    // 服务端余额 = 起始 - 2000 消耗 + 1,000,000 补偿
    const { d, stats } = await drawOneVip(start => start - 2000 + 1000000);

    check('没拿到 VIP 天数', !stats.gains.vip, `实际 ${stats.gains.vip}`);
    check('憨豆记了 1,000,000', stats.gains.beans === 1000000, `实际 ${stats.gains.beans}`);
    check('仍然算作一次 VIP 中奖，爆率统计不丢这一笔',
        stats.prizes.vip?.count === 1, JSON.stringify(stats.prizes.vip));
    check('没有凭空多出一次憨豆中奖',
        !stats.prizes.beans, JSON.stringify(stats.prizes.beans));
    check('VIP 档位标成「已转换为憨豆 1,000,000」',
        Object.keys(stats.prizes.vip?.tiers || {}).join('|') === '已转换为憨豆 1,000,000',
        Object.keys(stats.prizes.vip?.tiers || {}).join(' | '));
    check('原来的「7 天」档位已经撤掉',
        !stats.prizes.vip?.tiers['7 天'],
        JSON.stringify(stats.prizes.vip?.tiers));
    check('VIP 类别累计天数为 0',
        stats.prizes.vip?.value === 0, `实际 ${stats.prizes.vip?.value}`);
    check('折算的憨豆单独记在 swappedBeans 上',
        stats.prizes.vip?.swappedBeans === 1000000, `实际 ${stats.prizes.vip?.swappedBeans}`);

    check('VIP 卡片按次数显示，折算了也算一次',
        d.getElementById('total-vip-count').textContent === '1次',
        d.getElementById('total-vip-count').textContent);
    check('获得憨豆卡片下注明折算来源',
        d.getElementById('beans-swap-note').textContent === '其中 1,000,000 来自 VIP 折算',
        d.getElementById('beans-swap-note').textContent);
    check('说明行是显示状态',
        d.getElementById('beans-swap-note').classList.contains('is-on'));

    const vipSums = Array.from(d.querySelectorAll('#detail-list .hh-row'))
        .find(row => row.dataset.type === 'vip');
    const sumTexts = Array.from(vipSums?.querySelectorAll('.hh-row-sum') || []).map(el => el.textContent);
    check('天数为 0 时不显示「累计 0 天」',
        !sumTexts.some(text => text.includes('天')), sumTexts.join(' | '));
    check('类别行单独列出「另折算 1,000,000 憨豆」',
        sumTexts.join('|') === '另折算 1,000,000 憨豆', sumTexts.join(' | '));
    check('抽数还是 1，没被重复计',
        stats.draws === 1 && stats.cost === 2000, `${stats.draws} 抽 / ${stats.cost} 消耗`);
    check('原始文案照实保留 VIP',
        stats.raw['VIP 7 Day(s)'] === 1, JSON.stringify(stats.raw));
    check('日志说清楚了改发憨豆、且仍计为一次 VIP',
        Array.from(d.querySelectorAll('#lottery-log div'))
            .some(el => el.textContent.includes('已经是 VIP') && el.textContent.includes('仍计为一次 VIP 中奖')),
        '未找到说明日志');
    check('大奖特效照样触发', !!d.querySelector('.hh-jackpot-overlay'), '没触发');
}

/* ---------------------------------------------------------------- */
console.log('\n[39] 不是 VIP 的用户中 VIP，照常记 VIP 天数');
{
    // 服务端余额只少了消耗，没有补偿
    const { d, stats } = await drawOneVip(start => start - 2000);

    check('VIP 天数记了 7', stats.gains.vip === 7, `实际 ${stats.gains.vip}`);
    check('憨豆一分没加', stats.gains.beans === 0, `实际 ${stats.gains.beans}`);
    check('明细里进的是 VIP 那一类',
        stats.prizes.vip?.count === 1 && !stats.prizes.beans,
        JSON.stringify(stats.prizes));
    check('档位还是「7 天」，不是折算档',
        Object.keys(stats.prizes.vip?.tiers || {}).join('|') === '7 天',
        Object.keys(stats.prizes.vip?.tiers || {}).join(' | '));
    check('没有折算，就不该有 swappedBeans',
        !stats.prizes.vip?.swappedBeans, `实际 ${stats.prizes.vip?.swappedBeans}`);

    check('VIP 卡片同样按次数显示',
        d.getElementById('total-vip-count').textContent === '1次',
        d.getElementById('total-vip-count').textContent);
    check('没有折算就不显示那行说明',
        d.getElementById('beans-swap-note').textContent === ''
        && !d.getElementById('beans-swap-note').classList.contains('is-on'),
        d.getElementById('beans-swap-note').textContent);

    const vipRow = Array.from(d.querySelectorAll('#detail-list .hh-row'))
        .find(row => row.dataset.type === 'vip');
    const sums = Array.from(vipRow?.querySelectorAll('.hh-row-sum') || []).map(el => el.textContent);
    check('类别行只有「累计 7 天」一行',
        sums.join('|') === '累计 7 天', sums.join(' | '));
    check('不会误报改发憨豆',
        !Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('已经是 VIP')),
        '误报了');
}

/* ---------------------------------------------------------------- */
console.log('\n[40] 手动刷新余额正好撞上 VIP 折算，也不能把这一注漏掉');
{
    // 抽到 VIP 的同时手动点 🔄：早先的实现里 calibrateBalance 见到
    // calibrating 就直接 return false，折算被悄悄跳过，一百万憨豆不记账。
    const START = 500000;
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: String(START) });
    const w = dom.window;

    let luckyHits = 0;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            luckyHits++;
            // 第一次（手动刷新那次）故意拖慢，制造校准撞车
            if (luckyHits === 1) await sleep(1500);
            return {
                ok: true, status: 200,
                text: async () => `<html><body>
                    <div class="bean-number">${START - 2000 + 1000000}.0</div>
                    <div class="use-bean">每次消耗憨豆： 2000</div>
                </body></html>`
            };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: 'VIP 7 Day(s)' } })
        };
    };

    await run(dom);
    const d = w.document;

    // 先手动点一次刷新，让它卡在慢请求里，紧接着开抽
    d.getElementById('refresh-balance').click();
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();

    await untilStopped(d, 30000);
    await sleep(500);

    const stats = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('撞车时等它让开，折算照样完成',
        stats.gains.beans === 1000000, `实际 ${stats.gains.beans}`);
    check('仍然算一次 VIP 中奖', stats.prizes.vip?.count === 1, JSON.stringify(stats.prizes.vip));
    check('没有留下「没记上」的告警',
        !Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('没记上')),
        '出现了漏记告警');
}

/* ---------------------------------------------------------------- */
console.log('\n[41] VIP 折算核不到余额时要明说，不能装没事');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '500000' });
    const w = dom.window;

    w.fetch = async url => {
        // 校准一直失败
        if (String(url).includes('lucky.php')) return { ok: false, status: 502, text: async () => '' };
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: 'VIP 7 Day(s)' } })
        };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 30000);

    check('日志明确提示这一注可能漏记',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('没记上')),
        '没有任何提示');

    const stats = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('核不到就按原样记 VIP，不瞎猜', stats.gains.vip === 7, `实际 ${stats.gains.vip}`);
    check('憨豆不会凭空多出来', stats.gains.beans === 0, `实际 ${stats.gains.beans}`);
}

/* ---------------------------------------------------------------- */
console.log('\n[42] 折算金额按站点公布的算，不拿余额差当金额');
{
    // 憨豆会因为做种一直涨。校准读到的余额 = 起始 - 消耗 + 100 万补偿 + 60 做种，
    // 早先直接把 drift 当金额，记出了「1,000,060 憨豆」这种奖池里没有的档位。
    const START = 500000;
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: String(START) });
    const w = dom.window;

    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return {
                ok: true, status: 200,
                text: async () => `<html><body>
                    <div class="bean-number">${START - 2000 + 1000000 + 60}.0</div>
                    <div class="use-bean">每次消耗憨豆： 2000</div>
                    <div>当中奖 [VIP] 时，如果用户已经是 VIP 或以上等级，奖励憨豆： 1000000</div>
                </body></html>`
            };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: 'VIP 7 Day(s)' } })
        };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 30000);
    await sleep(300);

    const stats = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('记的是站点公布的 1,000,000，不是 1,000,060',
        stats.gains.beans === 1000000, `实际 ${stats.gains.beans}`);
    check('档位名也是整数 1,000,000',
        Object.keys(stats.prizes.vip?.tiers || {}).join('|') === '已转换为憨豆 1,000,000',
        Object.keys(stats.prizes.vip?.tiers || {}).join(' | '));
    check('多出来的 60 单独说明，不计入中奖',
        Array.from(d.querySelectorAll('#lottery-log div'))
            .some(el => el.textContent.includes('+60') && el.textContent.includes('未计入中奖')),
        Array.from(d.querySelectorAll('#lottery-log div')).map(el => el.textContent).slice(-3).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[43] 站点改了折算金额，脚本跟着改');
{
    const START = 500000;
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: String(START),
                          vipSwapBeans: 500000 });
    const w = dom.window;

    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return {
                ok: true, status: 200,
                text: async () => `<html><body>
                    <div class="bean-number">${START - 2000 + 500000}.0</div>
                    <div class="use-bean">每次消耗憨豆： 2000</div>
                    <div>当中奖 [VIP] 时，如果用户已经是 VIP 或以上等级，奖励憨豆： 500000</div>
                </body></html>`
            };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: 'VIP 7 Day(s)' } })
        };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 30000);
    await sleep(300);

    const stats = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('按页面上写的 500,000 记',
        stats.gains.beans === 500000, `实际 ${stats.gains.beans}`);
    check('档位名跟着变',
        Object.keys(stats.prizes.vip?.tiers || {}).join('|') === '已转换为憨豆 500,000',
        Object.keys(stats.prizes.vip?.tiers || {}).join(' | '));
}

/* 抽一注 VIP。classIcon 决定站点认不认「VIP 或以上」，
   serverBalance 决定校准时读到多少余额。 */
async function drawVipWith({ classIcon, className, serverBalance, swapRule = 1000000 }) {
    const START = 500000;
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: String(START) });
    const w = dom.window;

    let userdetailsHits = 0;
    w.fetch = async url => {
        const target = String(url);
        if (target.includes('usercp.php')) {
            return {
                ok: true, status: 200,
                text: async () => '<html><body><a href="userdetails.php?id=17321">我</a></body></html>'
            };
        }
        if (target.includes('userdetails.php')) {
            userdetailsHits++;
            if (!classIcon && !className) return { ok: false, status: 500, text: async () => '' };
            // 照抄线上的结构：图标带中文名，用户名那个 span 的 class
            // 是内核生成的 {ClassName}_Name，站点把显示名改成了「俺不中类」
            const icon = classIcon ? `<img alt="发布员" title="发布员" src="pic/${classIcon}.gif" />` : '';
            const named = className
                ? `<span class='${className}_Name font-bold'>俺不中类</span>`
                : `<span class='font-bold'>俺不中类</span>`;
            return {
                ok: true, status: 200,
                text: async () => `<html><body><span class="font-bold m-auto">等级：</span>
                    <span class='flex items-end'>${icon} ${named}</span>
                </body></html>`
            };
        }
        if (target.includes('lucky.php')) {
            return {
                ok: true, status: 200,
                text: async () => `<html><body>
                    <div class="bean-number">${serverBalance(START)}.0</div>
                    <div class="use-bean">每次消耗憨豆： 2000</div>
                    <div>当中奖 [VIP] 时，如果用户已经是 VIP 或以上等级，奖励憨豆： ${swapRule}</div>
                </body></html>`
            };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: 'VIP 7 Day(s)' } })
        };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 30000);
    await sleep(400);

    return {
        d, w, userdetailsHits,
        stats: JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4')),
        logs: Array.from(d.querySelectorAll('#lottery-log div')).map(el => el.textContent)
    };
}

/* ---------------------------------------------------------------- */
console.log('\n[44] 抽奖期间有人赠送魔力，不能误判成 VIP 折算');
{
    // 普通用户（Power User）中了真 VIP，同时收到 80 万赠送。
    // 只看余额差的话会当成折算，凭空记出一百万。
    const { stats, logs } = await drawVipWith({
        classIcon: 'power',
        serverBalance: start => start - 2000 + 800000
    });

    check('等级不够，判定为真拿到 VIP 天数', stats.gains.vip === 7, `实际 ${stats.gains.vip}`);
    check('憨豆一分没多记', stats.gains.beans === 0, `实际 ${stats.gains.beans}`);
    check('档位还是「7 天」',
        Object.keys(stats.prizes.vip?.tiers || {}).join('|') === '7 天',
        Object.keys(stats.prizes.vip?.tiers || {}).join(' | '));
    check('不会谎称已折算',
        !logs.some(line => line.includes('已经是 VIP')), logs.slice(-3).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[45] 等级够 VIP 但钱没到账，不能记成折算');
{
    // 线上真出过这个事故：一个号只中过一次 VIP、账面一分没多，
    // 却被记了一百万 —— 因为旧逻辑「等级说是就是」，根本不看余额。
    // 等级那条线本来就脆（usercp 上第一个 userdetails 链接未必是自己，
    // 「等级」二字也可能先出现在别处），必须由余额定性。
    const { stats, logs } = await drawVipWith({
        classIcon: 'uploader',
        serverBalance: start => start - 2000        // 只扣了抽奖成本
    });

    check('没有凭空记出一百万', stats.gains.beans === 0, `实际 ${stats.gains.beans}`);
    check('照实记成 7 天 VIP', stats.gains.vip === 7, `实际 ${stats.gains.vip}`);
    check('仍算一次 VIP 中奖', stats.prizes.vip?.count === 1, JSON.stringify(stats.prizes.vip));
    check('档位就是天数，不是折算', stats.prizes.vip?.tiers['7 天'] === 1,
        JSON.stringify(stats.prizes.vip?.tiers));
    check('日志说明等级够但账面没动',
        logs.some(line => line.includes('站点发的是天数')), logs.slice(-3).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[45b] 等级够 VIP 且钱到账了，才记折算');
{
    const { stats, userdetailsHits } = await drawVipWith({
        classIcon: 'uploader',
        serverBalance: start => start - 2000 + 1000000
    });

    check('按公布金额记一百万', stats.gains.beans === 1000000, `实际 ${stats.gains.beans}`);
    check('没拿到 VIP 天数', !stats.gains.vip, `实际 ${stats.gains.vip}`);
    check('仍算一次 VIP 中奖', stats.prizes.vip?.count === 1, JSON.stringify(stats.prizes.vip));
    check('等级只查一次', userdetailsHits === 1, `实际 ${userdetailsHits}`);
}

/* ---------------------------------------------------------------- */
console.log('\n[46] 等级读不到时，全凭余额定性');
{
    // 读不到等级 + 账面几乎没动 → 就是拿到了天数
    const flat = await drawVipWith({
        classIcon: null,
        serverBalance: start => start - 2000 + 300
    });
    check('账面没动就按 VIP 天数记', flat.stats.gains.vip === 7, `实际 ${flat.stats.gains.vip}`);
    check('憨豆不乱加', flat.stats.gains.beans === 0, `实际 ${flat.stats.gains.beans}`);

    // 读不到等级 + 余额多了 1,000,060（做种那 60 点）→ 按公布金额记
    const paid = await drawVipWith({
        classIcon: null,
        serverBalance: start => start - 2000 + 1000060
    });
    check('钱到账了就认，且按公布金额记，不把做种那 60 点算进去',
        paid.stats.gains.beans === 1000000, `实际 ${paid.stats.gains.beans}`);
    check('多出的 60 单独说明',
        paid.logs.some(line => line.includes('+60') && line.includes('未计入中奖')),
        paid.logs.slice(-3).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[46b] 等级明确不够，账面却多了一大笔：不认这是折算');
{
    // 抽奖期间有人赠送了一大笔魔力。站点的规则是「已是 VIP 才折算」，
    // 等级不够就不可能触发，这钱另有来源，不能凭它造出一个一百万的档位。
    const { stats, logs } = await drawVipWith({
        classIcon: 'user',
        serverBalance: start => start - 2000 + 1000000
    });

    check('按 VIP 天数记', stats.gains.vip === 7, `实际 ${stats.gains.vip}`);
    check('没把赠送的钱记成中奖', stats.gains.beans === 0, `实际 ${stats.gains.beans}`);
    check('日志点明等级不符合折算条件',
        logs.some(line => line.includes('不符合折算条件')), logs.slice(-3).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[47] 等级第一次查失败，下次还要再查');
{
    // 第一次 userdetails 请求 502，之后恢复。早先的实现把「查过了」写死在
    // 入口，一次失败就整个会话不再查，后面中 VIP 只能退回余额差去猜。
    const START = 500000;
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: String(START) });
    const w = dom.window;

    let userdetailsHits = 0;
    // 第一注账面只扣了成本（等级又查不到）→ 按 VIP 天数记；
    // 第二注那一百万真到账 → 配合重试查到的等级，判出折算。
    let luckyHits = 0;
    w.fetch = async url => {
        const target = String(url);
        if (target.includes('usercp.php')) {
            return {
                ok: true, status: 200,
                text: async () => '<html><body><a href="userdetails.php?id=1">我</a></body></html>'
            };
        }
        if (target.includes('userdetails.php')) {
            userdetailsHits++;
            if (userdetailsHits === 1) return { ok: false, status: 502, text: async () => '' };
            return {
                ok: true, status: 200,
                text: async () => '<html><body><span>等级：</span><img src="pic/uploader.gif" /></body></html>'
            };
        }
        if (target.includes('lucky.php')) {
            return {
                ok: true, status: 200,
                // 余额只反映消耗，不含补偿 —— 这样第一注（等级查不到时）
                // 走余额差也判不出折算，能干净地看出第二注是靠等级判出来的
                text: async () => `<html><body>
                    <div class="bean-number">${++luckyHits === 1 ? START - 2000 : START - 4000 + 1000000}.0</div>
                    <div class="use-bean">每次消耗憨豆： 2000</div>
                    <div>当中奖 [VIP] 时，如果用户已经是 VIP 或以上等级，奖励憨豆： 1000000</div>
                </body></html>`
            };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: 'VIP 7 Day(s)' } })
        };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '2';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 40000);
    await sleep(400);

    check('失败后重试了，不是一次失败就放弃',
        userdetailsHits >= 2, `实际只查了 ${userdetailsHits} 次`);

    const stats = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('两注 VIP 都记上了', stats.prizes.vip?.count === 2, `实际 ${stats.prizes.vip?.count}`);
    check('第一注等级查不到、账面也没多钱，按 VIP 记',
        stats.prizes.vip?.tiers['7 天'] === 1, JSON.stringify(stats.prizes.vip?.tiers));
    check('第二注等级查到了、钱也到账，判出折算',
        stats.prizes.vip?.tiers['已转换为憨豆 1,000,000'] === 1, JSON.stringify(stats.prizes.vip?.tiers));
    check('只折算了一注，憨豆恰好一百万',
        stats.gains.beans === 1000000, `实际 ${stats.gains.beans}`);
}

/* ---------------------------------------------------------------- */
console.log('\n[48] CSV 汇总里也要注明折算来源');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    // 一注真憨豆 + 一注被折算的 VIP
    w.localStorage.setItem('hhanclub_lottery_stats_v4', JSON.stringify({
        version: 4, draws: 2, cost: 4000,
        gains: { beans: 1000100, magic: 0, invite: 0, rainbow: 0, vip: 0, makeup: 0, upload: 0, rename: 0 },
        prizes: {
            beans: { count: 1, value: 100, tiers: { '100 憨豆': 1 } },
            vip: { count: 1, value: 0, swappedBeans: 1000000, tiers: { '已转换为憨豆 1,000,000': 1 } }
        },
        raw: {}
    }));

    const parts = [];
    w.Blob = function (chunks) { parts.push(String(chunks[0])); };

    await run(dom);
    const d = w.document;
    d.getElementById('view-mode').value = 'total';
    d.getElementById('view-mode').dispatchEvent(new w.Event('change'));
    await sleep(150);

    d.getElementById('export-stats').click();
    await sleep(300);

    const csv = parts[0] || '';
    check('CSV 里有「其中来自 VIP 折算」这一行',
        /其中来自 VIP 折算.*1000000/.test(csv),
        csv.split('\r\n').slice(-6).join(' | '));
    check('获得憨豆仍是含折算的总数',
        /获得憨豆.*1000100/.test(csv), csv.split('\r\n').slice(-6).join(' | '));
    check('盈亏按含折算的总数算',
        /憨豆盈亏.*996100/.test(csv), csv.split('\r\n').slice(-6).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[49] 间隔可以填两位小数');
{
    const dom = makeDom();
    const w = dom.window;
    await run(dom);
    const d = w.document;

    const input = d.getElementById('lottery-interval');
    const set = value => {
        input.value = value;
        input.dispatchEvent(new w.Event('change'));
        return JSON.parse(w.localStorage.getItem('hhanclub_lottery_settings_v1')).interval;
    };

    check('3.25 秒原样收下', set('3.25') === 3.25);
    check('输入框回填不补零', input.value === '3.25', input.value);
    check('当前间隔也显示小数',
        d.getElementById('current-interval').textContent === '3.25',
        d.getElementById('current-interval').textContent);

    check('第三位小数四舍五入到两位', set('3.256') === 3.26);
    check('整数不拖小数尾巴', set('5') === 5 && input.value === '5', input.value);
    check('下限 0.5 秒，正好填 0.5 收得下', set('0.5') === 0.5);
    check('低于下限收敛到 0.5', set('0.1') === 0.5);
    check('高于上限收敛到 300', set('9999') === 300);
    check('填了看不懂的东西就退回上一个值', set('abc') === 300, input.value);
}

/* ---------------------------------------------------------------- */
console.log('\n[50] 间隔说多久就是多久，不再随机浮动');
{
    // 旧实现在设定值上下浮动 15%，填 3 秒实际可能跑成 2.55 秒。
    // 这里连抽 4 次，量相邻两次请求的实际间距。
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    const stamps = [];
    w.fetch = async url => {
        const target = String(url);
        if (target.includes('lucky-draw')) stamps.push(Date.now());
        if (target.includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '100 魔力' } })
        };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '3.5';
    d.getElementById('max-lottery-count').value = '4';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 40000);

    check('4 次都抽出去了', stamps.length === 4, `实际 ${stamps.length} 次`);

    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    // 只卡下限：抖动会让间距缩到 2975ms 上下，没抖动就绝不会短于 3500。
    // 上限放宽到 5s —— jsdom 里 await 本身有开销，卡太死会假红。
    check('每次间隔都不短于设定的 3.5 秒',
        gaps.every(gap => gap >= 3450), gaps.join(' / '));
    check('也没有被拖长成别的数',
        gaps.every(gap => gap < 5000), gaps.join(' / '));
}

/* ---------------------------------------------------------------- */
console.log('\n[51] 站点的冷却就是上一抽的 duration，跟着它排队');
{
    // 实测：上一抽 duration 7666ms 要等到 7211ms 才放行，3976ms 的
    // 4322ms 就放行。duration 随机，所以任何固定间隔都躲不掉被拒。
    // 这里让站点报 2500ms，下限填 1 秒 —— 应该按 2500 + 500 排，不是 1 秒。
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    const stamps = [];
    w.fetch = async url => {
        const target = String(url);
        if (target.includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        stamps.push(Date.now());
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({
                ret: 0, data: { prize_text: '100 魔力', duration: 2500 }
            })
        };
    };

    await run(dom, { followDuration: true });
    const d = w.document;
    d.getElementById('lottery-interval').value = '1';
    d.getElementById('lottery-interval').dispatchEvent(new w.Event('change'));
    d.getElementById('max-lottery-count').value = '3';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 30000);

    check('3 次都抽出去了', stamps.length === 3, `实际 ${stamps.length} 次`);

    // 缓冲默认 0，计时从「发出请求」那刻算 —— 发枪间距应该就是 2500 上下
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    check('按转盘的 2500ms 排，没有按填的 1 秒',
        gaps.every(gap => gap >= 2350 && gap < 3600), gaps.join(' / '));
    check('面板报出上一抽的转盘时长和本次要等多久',
        d.getElementById('duration-info').textContent === '上一抽转盘 2.5s · 本次等 2.5s',
        d.getElementById('duration-info').textContent);
    check('缓冲输入框默认 0', d.getElementById('duration-buffer').value === '0',
        d.getElementById('duration-buffer').value);
}

/* ---------------------------------------------------------------- */
console.log('\n[52] 自适应开着时，手填的间隔完全不生效');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    const stamps = [];
    w.fetch = async url => {
        const target = String(url);
        if (target.includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        stamps.push(Date.now());
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({
                ret: 0, data: { prize_text: '100 魔力', duration: 600 }
            })
        };
    };

    await run(dom, { followDuration: true });
    const d = w.document;

    const interval = d.getElementById('lottery-interval');
    check('自适应接管后间隔输入框是灰的', interval.disabled === true);

    // 就算硬把值塞进去，也不该影响节奏
    interval.value = '3';
    interval.dispatchEvent(new w.Event('change'));

    d.getElementById('max-lottery-count').value = '3';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 30000);

    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    check('转盘只要 0.6 秒就按 0.6 秒走，填的 3 秒当没看见',
        gaps.every(gap => gap >= 500 && gap < 1600), gaps.join(' / '));
    check('「当前间隔」报的是实际节奏，不是输入框里的数',
        d.getElementById('current-interval').textContent === '0.6',
        d.getElementById('current-interval').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[53] 每抽的 duration 都不一样，逐抽跟上');
{
    // 站点的 duration 是随机的，不能只读第一次就当常数
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    const spins = [3000, 1000, 1000];
    const stamps = [];
    let i = 0;
    w.fetch = async url => {
        const target = String(url);
        if (target.includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        stamps.push(Date.now());
        const duration = spins[Math.min(i++, spins.length - 1)];
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '100 魔力', duration } })
        };
    };

    await run(dom, { followDuration: true });
    const d = w.document;
    d.getElementById('lottery-interval').value = '0.5';
    d.getElementById('lottery-interval').dispatchEvent(new w.Event('change'));
    d.getElementById('max-lottery-count').value = '3';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 30000);

    const gaps = stamps.slice(1).map((t, i2) => t - stamps[i2]);
    check('第一段按 3000 等', gaps[0] >= 2850 && gaps[0] < 4100, `实际 ${gaps[0]}`);
    check('第二段按 1000 等，跟着降下来', gaps[1] >= 900 && gaps[1] < 2100, `实际 ${gaps[1]}`);
}

/* ---------------------------------------------------------------- */
console.log('\n[54] 被「不要重复点击」挡回时快速补枪，不等满一个周期');
{
    // 实测：被拒不会重置服务端的冷却计时，也不扣憨豆，
    // 所以贴边失手的正确处理是 300ms 后直接补一枪
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    const stamps = [];
    w.fetch = async url => {
        const target = String(url);
        if (target.includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        stamps.push(Date.now());
        if (stamps.length === 2) {
            return {
                ok: true, status: 200,
                text: async () => JSON.stringify({ ret: -1, msg: '不要重复点击！' })
            };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({
                ret: 0, data: { prize_text: '100 魔力', duration: 1200 }
            })
        };
    };

    await run(dom, { followDuration: true });
    const d = w.document;
    d.getElementById('lottery-interval').value = '0.5';
    d.getElementById('lottery-interval').dispatchEvent(new w.Event('change'));
    d.getElementById('max-lottery-count').value = '2';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 30000);

    check('被拒后是补枪，总共 3 个请求换 2 次成功', stamps.length === 3, `实际 ${stamps.length}`);
    check('补枪来得快（~300ms），没等满一个周期',
        stamps[2] - stamps[1] >= 250 && stamps[2] - stamps[1] < 1100,
        `实际 ${stamps[2] - stamps[1]}ms`);

    const log = d.getElementById('lottery-log').textContent;
    check('日志说清没等够、几毫秒后补枪',
        /不要重复点击.*上一抽转盘 1.2 秒，没等够 · 300ms 后补一枪/.test(log),
        log.slice(0, 300));
}

/* ---------------------------------------------------------------- */
console.log('\n[55] 关掉跟随，就只认填的间隔');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    const stamps = [];
    w.fetch = async url => {
        const target = String(url);
        if (target.includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        stamps.push(Date.now());
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({
                ret: 0, data: { prize_text: '100 魔力', duration: 5000 }
            })
        };
    };

    await run(dom, { followDuration: true });
    const d = w.document;
    const toggle = d.getElementById('follow-duration');
    check('开关默认是开的', toggle.checked === true);

    check('自适应开着时间隔输入框是灰的',
        d.getElementById('lottery-interval').disabled === true);

    toggle.checked = false;
    toggle.dispatchEvent(new w.Event('change'));
    check('关掉这件事存下来了',
        JSON.parse(w.localStorage.getItem('hhanclub_lottery_settings_v1')).followDuration === false);
    check('关掉后间隔输入框恢复可用',
        d.getElementById('lottery-interval').disabled === false);

    d.getElementById('lottery-interval').value = '1.5';
    d.getElementById('lottery-interval').dispatchEvent(new w.Event('change'));
    d.getElementById('max-lottery-count').value = '3';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 30000);

    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    check('站点报 5 秒也不管，就走填的 1.5 秒',
        gaps.every(gap => gap >= 1400 && gap < 2600), gaps.join(' / '));
}

/* ---------------------------------------------------------------- */
console.log('\n[56] 缓冲可以自定义，负值也行');
{
    // 服务端在请求路上就开始计时，所以负缓冲是合法的贴边策略
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    const stamps = [];
    w.fetch = async url => {
        const target = String(url);
        if (target.includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        stamps.push(Date.now());
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({
                ret: 0, data: { prize_text: '100 魔力', duration: 2000 }
            })
        };
    };

    await run(dom, { followDuration: true });
    const d = w.document;

    const buffer = d.getElementById('duration-buffer');
    buffer.value = '-9999';
    buffer.dispatchEvent(new w.Event('change'));
    check('低于下限收敛到 -500', buffer.value === '-500', buffer.value);

    buffer.value = '-300';
    buffer.dispatchEvent(new w.Event('change'));
    check('负缓冲存下来了',
        JSON.parse(w.localStorage.getItem('hhanclub_lottery_settings_v1')).bufferMs === -300);

    d.getElementById('lottery-interval').value = '0.5';
    d.getElementById('lottery-interval').dispatchEvent(new w.Event('change'));
    d.getElementById('max-lottery-count').value = '3';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 30000);

    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    check('间距按 2000 - 300 = 1700 排',
        gaps.every(gap => gap >= 1550 && gap < 2700), gaps.join(' / '));
}

/* ---------------------------------------------------------------- */
console.log('\n[57] 开抽前刚手动转过一把：残留冷却别被误判成持续限流');
{
    // 第一枪就撞上残留冷却（本轮还没成功过，冷却剩多久未知）。
    // 300ms 连打会在最长 8 秒的冷却结束前攒满 12 连拒而误停 ——
    // 未知冷却要 1 秒一枪，连拒 4 次也照样抽完。
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    let posts = 0;
    w.fetch = async url => {
        const target = String(url);
        if (target.includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        posts++;
        if (posts <= 4) {
            return {
                ok: true, status: 200,
                text: async () => JSON.stringify({ ret: -1, msg: '不要重复点击！' })
            };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({
                ret: 0, data: { prize_text: '100 魔力', duration: 1000 }
            })
        };
    };

    await run(dom, { followDuration: true });
    const d = w.document;
    d.getElementById('lottery-interval').value = '0.5';
    d.getElementById('lottery-interval').dispatchEvent(new w.Event('change'));
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 30000);

    const stats = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('熬过 4 连拒，最终抽成了', stats.draws >= 1, `实际 ${stats.draws}`);

    const log = d.getElementById('lottery-log').textContent;
    check('没有被误判成持续限流', !log.includes('持续被限流'), log.slice(0, 300));
    check('日志说明冷却未知、放慢重试', /冷却剩多久未知，1000ms 后再试/.test(log),
        log.slice(0, 300));
}

/* ---------------------------------------------------------------- */
console.log('\n[58] 农民（class 0）要判成「不是 VIP」，不能判成「读不到」');
{
    // 线上事故的根因之一：CLASS_RANK 里没有 peasant，而且 `if (!rank)`
    // 连 rank 为 0 都当成读不到。等级判定一退化成 null 就只能靠余额猜，
    // 同期中一发 780,000 就把非 VIP 的号记成了折算。
    // H&R 不达标被降级的农民，恰恰就是挂机刷抽奖最容易掉进去的等级。
    const { stats, logs } = await drawVipWith({
        classIcon: 'peasant',
        className: 'Peasant',
        serverBalance: start => start - 2000 + 780000   // 同期中了一发 780,000
    });

    check('照实记成 7 天 VIP', stats.gains.vip === 7, `实际 ${stats.gains.vip}`);
    check('没有凭空记出一百万', stats.gains.beans === 0, `实际 ${stats.gains.beans}`);
    check('档位是天数不是折算', stats.prizes.vip?.tiers['7 天'] === 1,
        JSON.stringify(stats.prizes.vip?.tiers));
    check('日志点明等级不符合折算条件',
        logs.some(line => line.includes('不符合折算条件')), logs.slice(-3).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[59] 等级认 CSS 类名，站点换了图标也不瞎');
{
    // 站点把等级名改成了「俺不中类」，图标也可能随时换皮，
    // 但用户名那个 span 的 class 是内核按 class 序号生成的
    const { stats } = await drawVipWith({
        classIcon: null,
        className: 'Uploader',
        serverBalance: start => start - 2000 + 1000000
    });

    check('只凭 Uploader_Name 就判出够折算',
        stats.gains.beans === 1000000, `实际 ${stats.gains.beans}`);
    check('仍算一次 VIP 中奖', stats.prizes.vip?.count === 1, JSON.stringify(stats.prizes.vip));
}

/* ---------------------------------------------------------------- */
console.log('\n[60] 等级读不到时，780,000 顶上来的余额差不算折算');
{
    // 奖池里有 780,000 那一档，它一出就能把余额差顶过「至少一半」的门槛。
    // 等级读不到的情况下必须贴着公布金额才敢认，否则宁可漏记。
    const { stats, logs } = await drawVipWith({
        classIcon: null,
        className: null,                                 // userdetails 直接 500
        serverBalance: start => start - 2000 + 780000
    });

    check('按 VIP 天数记', stats.gains.vip === 7, `实际 ${stats.gains.vip}`);
    check('没把 780,000 当成折算', stats.gains.beans === 0, `实际 ${stats.gains.beans}`);
    check('日志说明数额对不上公布金额',
        logs.some(line => line.includes('数额也对不上公布的')), logs.slice(-3).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[61] 大奖名册：只收大奖，带时间，跟着历史统计一起存');
{
    // 780,000 和 VIP 是奖池里仅有的两档大奖，中一次隔几千抽，
    // 光靠只留 50 条的冒险日志根本回看不到
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    const texts = ['魔力 100 ', '魔力 780000 ', '魔力 1000 ', 'VIP 7 Day(s)'];
    let i = 0;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({
                ret: 0, data: { prize_text: texts[i++ % texts.length] }
            })
        };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '0.5';
    d.getElementById('max-lottery-count').value = '4';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 30000);
    await sleep(300);

    const stats = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('名册进了历史统计，不是只活在内存里',
        Array.isArray(stats.jackpots), JSON.stringify(stats.jackpots));
    check('只收了 780,000 和 VIP 两笔', stats.jackpots.length === 2,
        JSON.stringify(stats.jackpots.map(x => x.text)));
    check('100 / 1,000 憨豆这种没混进来',
        stats.jackpots.every(x => !/^魔力 (100|1000)\b/.test(x.text)),
        JSON.stringify(stats.jackpots.map(x => x.text)));
    check('每笔都带时间戳',
        stats.jackpots.every(x => x.at > 0), JSON.stringify(stats.jackpots));
    check('新的排在前面（VIP 是后中的）',
        /VIP/.test(stats.jackpots[0].text), JSON.stringify(stats.jackpots.map(x => x.text)));

    const rows = d.querySelectorAll('#jackpot-log .hh-jackpot-row');
    check('面板上两行都渲染出来了', rows.length === 2, `实际 ${rows.length} 行`);
    check('行里有时间', /\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(rows[0].textContent),
        rows[0].textContent);
    check('标题报了次数', d.getElementById('jackpot-count').textContent === '2 次',
        d.getElementById('jackpot-count').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[62] 本次没中过大奖时，指一下历史里还存着');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    w.localStorage.setItem('hhanclub_lottery_stats_v4', JSON.stringify({
        version: 4, draws: 5000, cost: 10000000,
        gains: { beans: 0, magic: 0, invite: 0, rainbow: 0, vip: 0, makeup: 0, upload: 0, rename: 0 },
        prizes: {}, raw: {},
        jackpots: [{ at: 1787280000000, text: '魔力 780000' }]
    }));

    await run(dom);
    const d = w.document;

    check('本次视图下提示历史里有',
        /历史里存着 1 次/.test(d.getElementById('jackpot-log').textContent),
        d.getElementById('jackpot-log').textContent);

    d.getElementById('view-mode').value = 'total';
    d.getElementById('view-mode').dispatchEvent(new w.Event('change'));
    await sleep(150);

    check('切到历史总计就列出来了',
        d.querySelectorAll('#jackpot-log .hh-jackpot-row').length === 1,
        d.getElementById('jackpot-log').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[63] 全屏庆祝留够截图时间，点一下 / Esc 都能关掉');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 780000 ' } })
        };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '0.5';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 20000);
    await sleep(300);

    const overlay = d.querySelector('.hh-jackpot-overlay');
    check('大奖弹了全屏庆祝', !!overlay);
    check('有关闭按钮', !!overlay.querySelector('.hh-jackpot-close'));
    check('按钮上带倒计时秒数',
        /\d+/.test(overlay.querySelector('.hh-jackpot-left').textContent),
        overlay.querySelector('.hh-jackpot-close').textContent);
    check('写明了抽奖没停',
        /抽奖没停/.test(overlay.querySelector('.hh-jackpot-hint').textContent));

    // 3 秒后还在 —— 老版本 3.2 秒就开始淡出了，截图根本来不及
    await sleep(3000);
    check('3 秒后还挂着，没有自己溜走',
        !!d.querySelector('.hh-jackpot-overlay') && !d.querySelector('.hh-jackpot-overlay.is-out'));

    // Esc 关掉
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    await sleep(50);
    check('按 Esc 开始收起', d.querySelector('.hh-jackpot-overlay.is-out') !== null);

    await sleep(800);
    check('收起后节点也清掉了', d.querySelector('.hh-jackpot-overlay') === null);
}

/* ---------------------------------------------------------------- */
console.log('\n[64] 名册之前中过的大奖：次数认得出来，时间是真没有');
{
    // 名册是后加的，老数据每抽只累加次数、没留时间戳，本地找不回来。
    // 但原始文案里数得出中过几次，如实标一行比装作没中过强。
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    w.localStorage.setItem('hhanclub_lottery_stats_v4', JSON.stringify({
        version: 4, draws: 17821, cost: 35642000,
        gains: { beans: 43264300, magic: 0, invite: 41, rainbow: 428, vip: 0, makeup: 1041, upload: 1235, rename: 0 },
        prizes: {
            beans: { count: 15071, value: 42264300, tiers: { '780,000 憨豆': 18, '100 憨豆': 4743 } },
            vip: { count: 5, value: 0, swappedBeans: 5000000, tiers: { '已转换为憨豆 1,000,000': 5 } }
        },
        raw: { '魔力 780000': 18, 'VIP 7 Day(s)': 5, '魔力 100': 4743 }
        // 没有 jackpots 字段 —— 就是升级前的老数据
    }));

    await run(dom);
    const d = w.document;
    d.getElementById('view-mode').value = 'total';
    d.getElementById('view-mode').dispatchEvent(new w.Event('change'));
    await sleep(150);

    const log = d.getElementById('jackpot-log');
    check('数出了 18 次 780,000 + 5 次 VIP = 23 次',
        /更早还中过 23 次/.test(log.textContent), log.textContent);
    check('说清了时间没有', /还没开始记时间/.test(log.textContent), log.textContent);
    check('100 憨豆这种没被算成大奖',
        !/更早还中过 4/.test(log.textContent), log.textContent);
    check('标题上的次数把老账也算进去',
        d.getElementById('jackpot-count').textContent === '23 次',
        d.getElementById('jackpot-count').textContent);
    check('没有伪造出带时间的条目',
        d.querySelectorAll('#jackpot-log .hh-jackpot-row').length === 0,
        log.innerHTML.slice(0, 200));
}

/* ---------------------------------------------------------------- */
console.log('\n[65] 老账和新记的能并排显示，互不重复计数');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    // 老数据里 3 次 780,000，其中 1 次已经被新版记进了名册
    w.localStorage.setItem('hhanclub_lottery_stats_v4', JSON.stringify({
        version: 4, draws: 5000, cost: 10000000,
        gains: { beans: 0, magic: 0, invite: 0, rainbow: 0, vip: 0, makeup: 0, upload: 0, rename: 0 },
        prizes: {}, raw: { '魔力 780000': 3 },
        jackpots: [{ at: 1787280000000, text: '魔力 780000' }]
    }));

    await run(dom);
    const d = w.document;
    d.getElementById('view-mode').value = 'total';
    d.getElementById('view-mode').dispatchEvent(new w.Event('change'));
    await sleep(150);

    const log = d.getElementById('jackpot-log');
    check('带时间的那次单独列出来',
        d.querySelectorAll('#jackpot-log .hh-jackpot-row').length === 1, log.textContent);
    check('剩下 2 次归到老账，没把已列出的重复计',
        /更早还中过 2 次/.test(log.textContent), log.textContent);
    check('标题合计 3 次', d.getElementById('jackpot-count').textContent === '3 次',
        d.getElementById('jackpot-count').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[66] 被限流没完没了也不停机');
{
    // 以前连续 12 次被限流就自动停。站点限流总会过去，
    // 停了反而白白空过一整夜。
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    const stamps = [];
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        stamps.push(Date.now());
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: -1, msg: '不要重复点击！' })
        };
    };

    await run(dom, { followDuration: true });
    const d = w.document;
    d.getElementById('max-lottery-count').value = '100';
    d.getElementById('start-lottery').click();

    await sleep(9000);

    check('被拒了十几次也没停', d.getElementById('lottery-status').textContent !== '已停止',
        d.getElementById('lottery-status').textContent);
    check(`还在补枪（${stamps.length} 次）`, stamps.length >= 6, `实际 ${stamps.length}`);

    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    check('补枪间隔也在按阶梯往上抬',
        gaps[gaps.length - 1] > gaps[0], gaps.join(' / '));

    d.getElementById('stop-lottery').click();
    await untilStopped(d, 5000);
}

/* ---------------------------------------------------------------- */
console.log('\n[67] 余额不足这种终态还是要停 —— 重试没有意义');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: -1, msg: '憨豆不足' })
        };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '0.5';
    d.getElementById('max-lottery-count').value = '10';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 15000);

    check('停了', d.getElementById('lottery-status').textContent === '已停止');
    check('日志说清是余额的事',
        /憨豆不足/.test(d.getElementById('lottery-log').textContent),
        d.getElementById('lottery-log').textContent.slice(-200));
}

/* ---------------------------------------------------------------- */
console.log('\n[68] 没有 AudioContext 的环境里，保活不能把抽奖带崩');
{
    // jsdom 就没有 AudioContext。保活是锦上添花，
    // 环境不支持就安静跳过，绝不能连累主流程
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    check('这个环境确实没有 AudioContext',
        !w.AudioContext && !w.webkitAudioContext);

    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '0.5';
    d.getElementById('max-lottery-count').value = '2';
    d.getElementById('start-lottery').click();
    await untilStopped(d, 15000);

    const stats = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('照样抽完了 2 次', stats.draws === 2, `实际 ${stats.draws}`);
    check('日志里没有报错', !/❌/.test(d.getElementById('lottery-log').textContent),
        d.getElementById('lottery-log').textContent.slice(-200));
}

/* ---------------------------------------------------------------- */
console.log('\n[69] 重复导入同一份记录会被认出来');
{
    /* 统计存的是累加值，没有逐抽流水，合并没法真去重 —— 重叠的部分
       一定被算两遍。所以只能在按下去之前认出来并说清楚。 */
    const dom = makeDom();
    const w = dom.window;

    const NativeBlob = w.Blob;
    let blobParts = null;
    w.Blob = function (parts, options) {
        blobParts = parts;
        return new NativeBlob(parts, options);
    };
    w.URL.createObjectURL = () => 'blob:stub';

    w.localStorage.setItem('hhanclub_lottery_stats_v4', JSON.stringify({
        version: 4, draws: 10, cost: 20000,
        gains: { beans: 3000, invite: 0, rainbow: 0, vip: 0, makeup: 0, upload: 0 },
        prizes: { beans: { count: 10, value: 3000, tiers: { '500 憨豆': 10 } } },
        raw: { '魔力 500': 10 },
        jackpots: [{ at: 1700000000000, text: '魔力 780000' }]
    }));

    await run(dom);
    const d = w.document;

    d.getElementById('backup-stats').click();
    await sleep(80);
    const backup = JSON.parse(blobParts[0]);

    check('备份带上了记录线编号', typeof backup.originId === 'string' && backup.originId.length > 4,
        String(backup.originId));
    check('备份带上了这一个文件的编号', typeof backup.exportId === 'string',
        String(backup.exportId));
    check('两个编号不是同一个', backup.originId !== backup.exportId);
    check('统计里也存下了记录线编号',
        JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4')).originId === backup.originId);

    const nativeCreate = d.createElement.bind(d);
    let picker = null;
    d.createElement = tag => {
        const el = nativeCreate(tag);
        if (tag === 'input') picker = el;
        return el;
    };

    // 打开导入弹窗但先不选，把弹窗本身交出来看
    const openDialog = async json => {
        picker = null;
        d.getElementById('import-stats').click();
        Object.defineProperty(picker, 'files', {
            configurable: true,
            get: () => [{ name: 'backup.json', text: async () => json }]
        });
        picker.dispatchEvent(new w.Event('change'));
        await until(() => !!d.querySelector('.hh-modal-overlay'), 5000);
        return d.querySelector('.hh-modal-overlay');
    };
    const choose = async (dialog, mode) => {
        dialog.querySelector(`[data-mode="${mode}"]`)
            .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        await until(() => !d.querySelector('.hh-modal-overlay'), 5000);
    };

    /* --- 自己的备份原样导回来 --- */
    let dialog = await openDialog(JSON.stringify(backup));
    check('弹了重复警告', !!dialog.querySelector('.hh-modal-warn'),
        dialog.textContent.replace(/\s+/g, ' ').slice(0, 200));
    check('警告点明是同源', /同源/.test(dialog.querySelector('.hh-modal-warn').textContent),
        dialog.querySelector('.hh-modal-warn').textContent);
    check('合并不再是推荐项',
        !dialog.querySelector('[data-mode="merge"]').classList.contains('hh-modal-primary'));
    check('抽数没变多，推荐的是取消',
        dialog.querySelector('[data-mode="cancel"]').classList.contains('hh-modal-primary'));
    check('合并按钮还在，用户仍然说了算',
        !!dialog.querySelector('[data-mode="merge"]'));
    check('日志里也提醒了一句',
        /同源|已经合并过/.test(d.getElementById('lottery-log').textContent),
        d.getElementById('lottery-log').textContent.slice(-200));

    await choose(dialog, 'cancel');
    check('取消之后数据一点没动',
        JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4')).draws === 10);

    /* --- 别人的备份：不同记录线、没有重合的大奖，不该报警 --- */
    const friend = {
        kind: 'hhclub-lottery-backup', version: 4,
        originId: 'friend-origin', exportId: 'friend-export-1',
        total: {
            version: 4, draws: 7, cost: 14000,
            gains: { beans: 1000 },
            prizes: { beans: { count: 7, value: 1000, tiers: { '500 憨豆': 7 } } },
            raw: { '魔力 500': 7 },
            jackpots: [{ at: 1600000000000, text: '魔力 780000' }]
        }
    };

    dialog = await openDialog(JSON.stringify(friend));
    check('别人的记录不报警', !dialog.querySelector('.hh-modal-warn'),
        dialog.textContent.replace(/\s+/g, ' ').slice(0, 200));
    check('合并仍是推荐项',
        dialog.querySelector('[data-mode="merge"]').classList.contains('hh-modal-primary'));
    await choose(dialog, 'merge');
    check('合并进来了，17 抽',
        JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4')).draws === 17,
        JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4')).draws);

    /* --- 同一个文件再来一次 --- */
    dialog = await openDialog(JSON.stringify(friend));
    check('同一个文件第二次进来就被认出',
        /已经合并过/.test(dialog.querySelector('.hh-modal-warn')?.textContent || ''),
        dialog.textContent.replace(/\s+/g, ' ').slice(0, 200));
    await choose(dialog, 'cancel');

    /* --- 同一条记录线的新快照：换了 exportId 也躲不掉 --- */
    const friendLater = JSON.parse(JSON.stringify(friend));
    friendLater.exportId = 'friend-export-2';
    friendLater.total.draws = 40;

    dialog = await openDialog(JSON.stringify(friendLater));
    check('换个文件编号但记录线没变，照样认出',
        !!dialog.querySelector('.hh-modal-warn'),
        dialog.textContent.replace(/\s+/g, ' ').slice(0, 200));
    check('对方抽数更多时推荐覆盖，而不是取消',
        dialog.querySelector('[data-mode="replace"]').classList.contains('hh-modal-primary'));
    await choose(dialog, 'cancel');

    /* --- 老备份没有编号，靠大奖时刻对表 --- */
    const legacy = {
        version: 4, draws: 5, cost: 10000,
        gains: { beans: 0 }, prizes: {}, raw: {},
        // 这一条的时刻和当前历史里的那条一模一样
        jackpots: [{ at: 1700000000000, text: '魔力 780000' }]
    };

    dialog = await openDialog(JSON.stringify(legacy));
    check('没有编号的老备份靠大奖时刻也能认出重合',
        /大奖记录/.test(dialog.querySelector('.hh-modal-warn')?.textContent || ''),
        dialog.textContent.replace(/\s+/g, ' ').slice(0, 200));
    await choose(dialog, 'cancel');

    check('前后这么多次弹窗，数据始终是 17 抽',
        JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4')).draws === 17,
        JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4')).draws);
}

/* ---------------------------------------------------------------- */
console.log('\n[70] 中奖就停：VIP 与 780,000 憨豆是两个独立复选项');
{
    const stubFetch = (w, texts) => {
        let i = 0;
        w.fetch = async url => {
            if (String(url).includes('lucky.php')) {
                return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
            }
            return {
                ok: true, status: 200,
                text: async () => JSON.stringify({
                    ret: 0, data: { prize_text: texts[i++ % texts.length] }
                })
            };
        };
    };

    const startFive = (d, w) => {
        d.getElementById('lottery-interval').value = '0.3';
        d.getElementById('max-lottery-count').value = '5';
        d.getElementById('start-lottery').click();
        return untilStopped(d, 30000).then(() => sleep(200));
    };
    const setOption = (input, checked, w) => {
        if (!input) return;
        input.checked = checked;
        input.dispatchEvent(new w.Event('change'));
    };

    /* --- 两项默认都关着：中了也接着抽 --- */
    const domA = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    stubFetch(domA.window, ['魔力 100 ', '魔力 780000 ', '魔力 100 ', '魔力 100 ', '魔力 100 ']);
    await run(domA);
    const a = domA.window.document;

    const defaultVip = a.getElementById('stop-on-vip');
    const default780k = a.getElementById('stop-on-780k');
    check('面板上有 VIP（含折算）复选项', !!defaultVip);
    check('面板上有 780,000 憨豆复选项', !!default780k);
    check('两项默认都关着', defaultVip?.checked === false && default780k?.checked === false,
        `${defaultVip?.checked} / ${default780k?.checked}`);

    await startFive(a, domA.window);

    let stats = JSON.parse(domA.window.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('两项都关着：780,000 之后照抽满 5 抽', stats.draws === 5, `实际 ${stats.draws}`);
    check('关着的时候全屏庆祝还是说「抽奖没停」',
        /抽奖没停/.test(a.querySelector('.hh-jackpot-hint')?.textContent || ''),
        a.querySelector('.hh-jackpot-hint')?.textContent);

    /* --- 只勾 780,000：先来的 VIP 不停，到 780,000 才停 --- */
    const domB = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    stubFetch(domB.window, ['VIP 7 Day(s)', '魔力 780000 ', '魔力 100 ', '魔力 100 ', '魔力 100 ']);
    await run(domB);
    const b = domB.window.document;

    setOption(b.getElementById('stop-on-780k'), true, domB.window);
    await sleep(50);

    const saved = JSON.parse(domB.window.localStorage.getItem('hhanclub_lottery_settings_v1'));
    check('两个复选项分别持久化', saved.stopOnVip === false && saved.stopOn780k === true,
        JSON.stringify({ stopOnVip: saved.stopOnVip, stopOn780k: saved.stopOn780k }));

    await startFive(b, domB.window);

    stats = JSON.parse(domB.window.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('只勾 78 万：第 1 抽 VIP 不停，第 2 抽 78 万才停', stats.draws === 2, `实际 ${stats.draws}`);
    check('两笔大奖本身都记下来了', stats.jackpots.length === 2,
        JSON.stringify(stats.jackpots.map(x => x.text)));
    check('面板显示已停止', b.getElementById('lottery-status').textContent === '已停止',
        b.getElementById('lottery-status').textContent);
    check('日志说清了是命中 780,000 才停的',
        /780,000.*已按设置停止/.test(b.getElementById('lottery-log').textContent),
        b.getElementById('lottery-log').textContent.slice(-300));
    check('全屏庆祝里的那句话跟着换了',
        /已按设置停止抽奖/.test(b.querySelector('.hh-jackpot-hint')?.textContent || ''),
        b.querySelector('.hh-jackpot-hint')?.textContent);

    /* --- 只勾 VIP：先来的 780,000 不停，到 VIP 才停 --- */
    const domC = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    stubFetch(domC.window, ['魔力 780000 ', 'VIP 7 Day(s)', '魔力 100 ', '魔力 100 ', '魔力 100 ']);
    await run(domC);
    const c = domC.window.document;
    setOption(c.getElementById('stop-on-vip'), true, domC.window);
    await startFive(c, domC.window);

    stats = JSON.parse(domC.window.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('只勾 VIP：第 1 抽 78 万不停，第 2 抽 VIP 才停', stats.draws === 2, `实际 ${stats.draws}`);
    check('这一注 VIP 记上了才停',
        stats.prizes.vip && stats.prizes.vip.count === 1,
        JSON.stringify(stats.prizes.vip));

    /* --- 旧版总开关开启过：升级后迁移为两项都勾上 --- */
    const domD = makeDom({ pool: REAL_POOL });
    domD.window.localStorage.setItem('hhanclub_lottery_settings_v1', JSON.stringify({ stopOnJackpot: true }));
    await run(domD);
    const d = domD.window.document;
    check('旧 stopOnJackpot=true 迁移为两项都开启',
        d.getElementById('stop-on-vip')?.checked === true
        && d.getElementById('stop-on-780k')?.checked === true,
        `${d.getElementById('stop-on-vip')?.checked} / ${d.getElementById('stop-on-780k')?.checked}`);
}

/* ---------------------------------------------------------------- */
console.log('\n[71] 只是「看着像」的重叠，提醒一句就够，别把正常合并劝退');
{
    /* 两个人在同一段时间里各刷各的，抽得少的那份时间区间自然被罩住 ——
       这不是证据。摆出和铁证一样的脸色，会把正常的跨设备合并劝退。 */
    const dom = makeDom();
    const w = dom.window;

    const now = Date.now();
    w.localStorage.setItem('hhanclub_lottery_stats_v4', JSON.stringify({
        version: 4, draws: 5000, cost: 10000000,
        gains: { beans: 9000000 },
        prizes: { beans: { count: 5000, value: 9000000, tiers: { '500 憨豆': 5000 } } },
        raw: { '魔力 500': 5000 },
        jackpots: [],
        firstAt: now - 90 * 86400000,
        lastAt: now
    }));

    await run(dom);
    const d = w.document;

    const nativeCreate = d.createElement.bind(d);
    let picker = null;
    d.createElement = tag => {
        const el = nativeCreate(tag);
        if (tag === 'input') picker = el;
        return el;
    };
    const openDialog = async json => {
        picker = null;
        d.getElementById('import-stats').click();
        Object.defineProperty(picker, 'files', {
            configurable: true,
            get: () => [{ name: 'backup.json', text: async () => json }]
        });
        picker.dispatchEvent(new w.Event('change'));
        await until(() => !!d.querySelector('.hh-modal-overlay'), 5000);
        return d.querySelector('.hh-modal-overlay');
    };

    // 朋友的号：另一条记录线、没有重合的大奖，只是区间被罩住、抽数更少
    const friend = JSON.stringify({
        kind: 'hhclub-lottery-backup', version: 4,
        originId: 'someone-else', exportId: 'someone-else-1',
        total: {
            version: 4, draws: 300, cost: 600000,
            gains: { beans: 500000 },
            prizes: { beans: { count: 300, value: 500000, tiers: { '500 憨豆': 300 } } },
            raw: { '魔力 500': 300 },
            jackpots: [],
            firstAt: now - 60 * 86400000,
            lastAt: now - 30 * 86400000
        }
    });

    const dialog = await openDialog(friend);
    const warn = dialog.querySelector('.hh-modal-warn');
    check('还是提醒了一句', !!warn, dialog.textContent.replace(/\s+/g, ' ').slice(0, 200));
    check('但用的是「看着像」那副软脸色',
        warn.classList.contains('is-soft'), warn.className);
    check('说清了也可能只是巧合',
        /巧合/.test(warn.textContent), warn.textContent);
    check('推荐项没被动，合并仍是主路径',
        dialog.querySelector('[data-mode="merge"]').classList.contains('hh-modal-primary'));
    check('也没摆出「会被算两遍」的吓人措辞',
        !/算两遍/.test(dialog.querySelector('[data-mode="merge"]').textContent),
        dialog.querySelector('[data-mode="merge"]').textContent);

    dialog.querySelector('[data-mode="merge"]')
        .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await until(() => !d.querySelector('.hh-modal-overlay'), 5000);
    check('合得进去，5,300 抽',
        JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4')).draws === 5300,
        JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4')).draws);
}

/* ---------------------------------------------------------------- */
console.log('\n[72] 中大奖停机前先把余额校准回来');
{
    /* 开这个功能就是为了停在中奖那一刻对账，面板上摆个本地估算说不过去。 */
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    let i = 0;
    let calibrations = 0;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            calibrations++;
            // 校准时回的页面把余额写成 999,999，和本地估算明显不同
            return {
                ok: true, status: 200,
                text: async () => '<html><body><span class="bean-number">999999</span>'
                    + '<span class="use-bean">每次消耗憨豆： 2000</span></body></html>'
            };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({
                ret: 0, data: { prize_text: i++ === 0 ? '魔力 100 ' : '魔力 780000 ' }
            })
        };
    };

    await run(dom);
    const d = w.document;
    const stop780k = d.getElementById('stop-on-780k');
    if (stop780k) {
        stop780k.checked = true;
        stop780k.dispatchEvent(new w.Event('change'));
    }
    d.getElementById('lottery-interval').value = '0.3';
    d.getElementById('max-lottery-count').value = '10';

    const before = calibrations;
    d.getElementById('start-lottery').click();
    await untilStopped(d, 30000);
    await sleep(300);

    check('停在第 2 抽', JSON.parse(
        w.localStorage.getItem('hhanclub_lottery_stats_v4')).draws === 2);
    check('收工前回服务端要了一次余额', calibrations > before,
        `${before} → ${calibrations}`);
    check('面板上是校准回来的权威值，不是本地估算',
        /999,999/.test(d.getElementById('bean-balance').textContent),
        d.getElementById('bean-balance').textContent);
}

/* ---------------------------------------------------------------- */
console.log(`\n=========== ${passed} passed, ${failed} failed ===========\n`);
process.exit(failed ? 1 : 0);

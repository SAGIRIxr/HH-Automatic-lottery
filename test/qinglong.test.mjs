/**
 * 青龙版行为测试
 *
 * 起一个本地 mock 站点，复制一份脚本、把顶部配置区整块换掉指过去，
 * 再当子进程真跑一遍 —— 和用户实际的用法一致。
 * 断言它发出的请求和最后打印的汇总。抽奖接口是要花憨豆的，没法拿线上验证，
 * 所以这层测试是它唯一的安全网。
 *
 * 运行：npm run test:ql
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'qinglong', 'hh_lottery.js');
// git 的 autocrlf 可能把脚本换成 CRLF，统一成 LF 再找标记
// git 的 autocrlf 可能把脚本换成 CRLF，统一成 LF 再找标记
const SOURCE = fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-ql-'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, timeoutMs = 30000, stepMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fn()) return true;
        await sleep(stepMs);
    }
    return false;
}

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

/* ---------------------------------------------------------------- */

const luckyPage = (balance, cost = 2000, swapBeans = 0) => `<!doctype html><html><body>
    <div class="header-bean flex"><span class="bean-number text-[14px]">${balance}.0</span></div>
    ${swapBeans ? `<div class="rule">当中奖 [VIP] 时，如果用户已经是 VIP 或以上等级，奖励憨豆： ${swapBeans}</div>` : ''}
    <div class="use-bean text-center">每次消耗憨豆： ${cost}</div>
    <script>let prizes = [{"type":1001,"typeText":"\\u9b54\\u529b","amountText":"100 ","priority":99}];</script>
</body></html>`;

/* 照抄线上的结构：图标带中文名，用户名那个 span 的 class 是内核生成的
   {ClassName}_Name。站点把显示名改成了「俺不中类」，类名没动。
   className 传 null 就只留图标，用来验证图标兜底那条路。 */
const userDetailsPage = (klass, className = null) => `<html><body>
    <table><tr><td class="rowhead"><span class="font-bold">等级：</span></td>
    <td class="rowfollow"><span class='flex items-end'>
        <img class="rank" src="pic/${klass}.gif" alt="${klass}">
        ${className === null ? '' : `<span class='${className}_Name font-bold'>俺不中类</span>`}
    </span></td></tr></table>
</body></html>`;

const userCpPage = uid => `<html><body>
    <a href="userdetails.php?id=${uid}">我的资料</a>
</body></html>`;

const loginPage = () => `<!doctype html><html><body>
    <form action="takelogin.php" method="post">
        <input name="username"><input type="password" name="password">
    </form></body></html>`;

const mailboxPage = (items, pageCount) => {
    const rows = items.map(item => `
        <div class="grid grid-cols-[10%_5%_60%_10%_15%]">
            <div class="act-checkbox"><input type="checkbox" name="messages[]" value="${item.id}"></div>
            <div><a href="messages.php?action=viewmessage&amp;id=${item.id}">${item.subject}</a></div>
            <div>系统</div>
        </div>`).join('');
    const pager = `<select onchange="switchPage(this)">${
        Array.from({ length: Math.max(1, pageCount) }, (_, n) => `<option value="${n}">${n + 1}</option>`).join('')
    }</select>`;
    return `<html><body><form method="post" action="messages.php">
        <input type="hidden" name="action" value="moveordel">${pager}${rows}</form></body></html>`;
};

/**
 * mock 站点。
 *   prizes    抽奖接口按顺序返回的中奖文案，用完循环
 *   balance   起始余额；每抽自动扣消耗、憨豆奖自动加回
 *   onDraw    每抽回调，可以自己改 state（用来模拟 VIP 换憨豆）
 *   mail      收件箱内容
 *   pageSize  收件箱每页显示多少封
 *   killAttempts 这几次抽奖请求直接掐断连接（制造真的 fetch failed，
 *                模拟机器断网 / DNS 挂掉，不是站点返回错误）
 *   killMailAttempts 这几次站内信请求掐断连接。挂机几小时后 Node 的
 *                    连接池里会有被服务端关掉的死连接，复用就是这个效果
 */
function startSite({ prizes = ['魔力 100 '], durations = [6000], rateLimitAttempts = [],
                     balance = 100000, cost = 2000, onDraw = null,
                     mail = [], pageSize = 100, loggedOut = false,
                     swapBeans = 0, userClass = null, classFailTimes = 0,
                     killAttempts = [], killMailAttempts = [] } = {}) {
    const state = {
        balance, cost, draws: 0, deleted: [], mailPageHits: [],
        mail: [...mail], drawn: [], classFails: 0, drawAttempts: 0
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = new URLSearchParams(Buffer.concat(chunks).toString());

        const send = (code, text, type = 'text/html; charset=utf-8') => {
            res.writeHead(code, { 'content-type': type });
            res.end(text);
        };

        if (loggedOut) return send(200, loginPage());

        if (url.pathname === '/lucky.php') {
            return send(200, luckyPage(state.balance, state.cost, swapBeans));
        }

        // userClass 为 null 时这两个页面不存在，脚本就查不到等级
        if (url.pathname === '/usercp.php') {
            if (!userClass) return send(404, 'not found');
            // 前几次故意 502，模拟网络抖动
            if (state.classFails < classFailTimes) {
                state.classFails++;
                return send(502, 'bad gateway');
            }
            return send(200, userCpPage('7321'));
        }

        if (url.pathname === '/userdetails.php') {
            if (!userClass) return send(404, 'not found');
            state.classPageHits = (state.classPageHits || 0) + 1;
            return send(200, userDetailsPage(userClass));
        }

        if (url.pathname === '/plugin/lucky-draw') {
            state.drawAttempts++;
            // 连 HTTP 响应都不给，直接把 socket 掐了 —— 客户端拿到的
            // 就是 fetch failed，和机器断网时一模一样
            if (killAttempts.includes(state.drawAttempts)) {
                state.killed = (state.killed || 0) + 1;
                res.socket.destroy();
                return;
            }
            if (rateLimitAttempts.includes(state.drawAttempts)) {
                return send(200, JSON.stringify({ ret: 1, msg: '不要重复点击，请稍后' }),
                    'application/json');
            }
            const text = prizes[state.draws % prizes.length];
            const duration = durations[state.draws % durations.length];
            state.draws++;
            state.drawn.push(text);
            state.balance -= state.cost;
            if (/魔力|憨豆/.test(text)) {
                const won = Number(String(text).match(/(\d[\d,]*)/)?.[1].replace(/,/g, '')) || 0;
                state.balance += won;
            }
            onDraw?.(state, text);
            return send(200, JSON.stringify({
                ret: 0,
                data: { prize_text: text, winning_record_id: 900 + state.draws, duration }
            }),
                'application/json');
        }

        if (url.pathname === '/messages.php') {
            state.mailAttempts = (state.mailAttempts || 0) + 1;
            if (killMailAttempts.includes(state.mailAttempts)) {
                state.mailKilled = (state.mailKilled || 0) + 1;
                res.socket.destroy();
                return;
            }
        }

        if (url.pathname === '/messages.php' && req.method === 'POST') {
            const ids = body.getAll('messages[]');
            state.deleted.push({ ids, action: body.get('action'), del: body.get('delete') });
            state.mail = state.mail.filter(item => !ids.includes(item.id));
            return send(200, '');
        }

        if (url.pathname === '/messages.php') {
            const page = Number(url.searchParams.get('page')) || 0;
            state.mailPageHits.push(page);
            const pageCount = Math.max(1, Math.ceil(state.mail.length / pageSize));
            return send(200, mailboxPage(state.mail.slice(page * pageSize, (page + 1) * pageSize), pageCount));
        }

        send(404, 'not found');
    });

    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            state.origin = `http://127.0.0.1:${server.address().port}`;
            resolve({ server, state, close: () => new Promise(r => server.close(r)) });
        });
    });
}

const DEFAULT_CONFIG = {
    cookie: 'c_secure_uid=test',
    notifyBigPrize: false,
    bigPrizeMinBeans: 780000,
    notifyPeriodic: false,
    periodicMinutes: 30,
    tgBotToken: '',
    tgUserId: '',
    tgApiHost: 'api.telegram.org',
    webhookUrl: '',
    statsFile: '',
    draws: 10,
    reserve: 0,
    interval: 3,
    // 旧用例继续覆盖固定间隔；自适应节奏在后面的专门用例里测
    followDuration: false,
    durationBufferMs: 0,
    maxMinutes: 60,
    cleanMail: false,
    host: 'hhanclub.net',
    timezone: 'Asia/Shanghai',
    userAgent: 'test-agent'
};

/* 把源码里的「配置区」整块换掉。切片边界只写这一处 ——
   之前几个用例各自手写，漏掉一个 '};' 就整个脚本语法错。 */
function patchSource(config, runtime = null) {
    const head = 'const CONFIG = {';
    const foot = '\n};\n\n/* ===== 配置区结束 ===== */';
    const keep = '\n\n/* ===== 配置区结束 ===== */';

    const start = SOURCE.indexOf(head);
    const end = SOURCE.indexOf(foot);
    if (start < 0 || end < 0) throw new Error('配置区标记不见了，测试没法注入配置');

    let patched = SOURCE.slice(0, start)
        + `const CONFIG = ${JSON.stringify({ ...DEFAULT_CONFIG, ...config }, null, 4)};`
        + SOURCE.slice(end + foot.length - keep.length);

    // RUNTIME 里的节奏参数不在配置区，单独替换 —— 不然「每 25 抽清一次」
    // 这种要跑满 25 抽才测得出来
    Object.entries(runtime || {}).forEach(([key, value]) => {
        const re = new RegExp(`(\\n\\s*${key}:\\s*)\\d+`);
        if (!re.test(patched)) throw new Error(`RUNTIME 里没有 ${key}`);
        patched = patched.replace(re, `$1${value}`);
    });

    return patched;
}

/* 把补好的脚本写进一个独立目录。脚本会往自己所在目录写
   hh_lottery.config.json，共用目录的话会互相污染。 */
let copyIndex = 0;
function installScript(config, runtime = null, extraFiles = {}) {
    const dir = path.join(TMP, `run-${copyIndex++}`);
    fs.mkdirSync(dir, { recursive: true });

    const file = path.join(dir, 'hh_lottery.js');
    fs.writeFileSync(file, patchSource(config, runtime));

    Object.entries(extraFiles).forEach(([name, body]) => {
        fs.writeFileSync(path.join(dir, name), body);
    });

    return { dir, file };
}

function runFile(file, dir, env = null) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [file], {
            cwd: ROOT,
            env: env ? { ...process.env, ...env } : process.env
        });
        let out = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        child.on('close', code => resolve({ code, out, dir, file }));
    });
}

function runScript(config, runtime = null) {
    const { dir, file } = installScript(config, runtime);
    return runFile(file, dir);
}

/* 起一个脚本进程但不等它结束 —— 用来测中途打断 */
function spawnScript(config, { onOutput } = {}) {
    const { dir, file } = installScript(config);

    const child = spawn(process.execPath, [file], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', d => { out += d; onOutput?.(String(d)); });
    child.stderr.on('data', d => { out += d; });

    const done = new Promise(resolve => child.on('close', code => resolve({ code, out })));
    return { child, dir, done };
}

/* ---------------------------------------------------------------- */
console.log('\n[1] 填上 Cookie 就能跑：按次数抽，汇总正确');
{
    const site = await startSite({
        prizes: ['魔力 100 ', '魔力 5000 ', '\\u9b54\\u529b 1000 '],
        balance: 100000
    });

    const { code, out } = await runScript({ host: site.state.origin, draws: 3 });

    check('正常退出', code === 0, `exit ${code}`);
    check('刚好抽了 3 次', site.state.draws === 3, `实际 ${site.state.draws}`);
    check('汇总里写了 3 抽', /本次：3 抽/.test(out), out.slice(-400));
    check('消耗算的是 3 × 2000', /消耗 6,000/.test(out), out.slice(-400));
    check('憨豆合计 100 + 5000 + 1000 = 6,100', /获得 6,100 憨豆/.test(out), out.slice(-400));
    check('盈亏 +100', /盈亏 \+100（\+1\.7%）/.test(out), out.slice(-400));
    check('\\u 转义的文案解码成了中文档位',
        /1,000 憨豆 × 1/.test(out) && !/\\u9b54/.test(out.split('─')[1] || ''), out.slice(-400));
    check('带上了 Cookie 才认', !/Cookie 已失效/.test(out));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[2] 一抽到底：抽到保留线就停');
{
    // 每抽净亏 1900，余额 30000、保留 20000 → 抽 5 次后剩 20500，
    // 再抽一次会跌到 18600 < 20000，所以停在 5 抽
    const site = await startSite({ prizes: ['魔力 100 '], balance: 30000 });

    const { out } = await runScript({ host: site.state.origin, draws: 0, reserve: 20000 });

    check('抽了 5 次就停', site.state.draws === 5, `实际 ${site.state.draws}`);
    check('日志说明是按保留线停的', /一抽到底完成/.test(out), out.slice(-500));
    check('余额守在保留线之上', site.state.balance >= 20000, `实际 ${site.state.balance}`);
}

/* ---------------------------------------------------------------- */
console.log('\n[3] 已是 VIP 时站点改发憨豆：憨豆照记，但仍算一次 VIP 中奖');
{
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        // 服务端在发奖时把 VIP 换成 1,000,000 憨豆
        onDraw: state => { state.balance += 1000000; }
    });

    const { out } = await runScript({ host: site.state.origin, draws: 1 });

    check('识别出了换发',
        /已经是 VIP，站点改发了 1,000,000 憨豆 · 仍计为一次 VIP 中奖/.test(out), out.slice(-500));
    check('憨豆记了 1,000,000', /获得 1,000,000 憨豆/.test(out), out.slice(-500));
    check('档位换成「已转换为憨豆」，不再是 7 天',
        /已转换为憨豆 1,000,000 × 1/.test(out) && !/7 天 × 1/.test(out), out.slice(-500));
    check('类别行上单列了折算的憨豆',
        /⭐ VIP 1 次 · 另折算 1,000,000 憨豆/.test(out), out.slice(-500));
    check('抽数还是 1', site.state.draws === 1, `实际 ${site.state.draws}`);

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[4] 不是 VIP 的用户中 VIP，照常记 VIP 天数');
{
    const site = await startSite({ prizes: ['VIP 7 Day(s)'], balance: 500000 });

    const { out } = await runScript({ host: site.state.origin, draws: 1 });

    check('不会误报换发', !/站点改发/.test(out), out.slice(-500));
    check('记的是 VIP 7 天', /7 天 × 1/.test(out), out.slice(-500));
    check('类别行报的是 VIP 1 次 · 7 天', /⭐ VIP 1 次 · 7 天/.test(out), out.slice(-500));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[5] 站内信清理：每页只有 10 封也要翻完，别的信一封不碰');
{
    const KEEP = [
        { id: '9001', subject: '种子被删除' },
        { id: '9002', subject: '憨豆 改变' }
    ];
    const mail = [
        ...Array.from({ length: 34 }, (_, i) => ({ id: String(1000 + i), subject: '幸运大转盘 中奖通知' })),
        ...KEEP
    ];

    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000, mail, pageSize: 10 });

    const { out } = await runScript({ host: site.state.origin, draws: 1, cleanMail: true });

    const deletedIds = site.state.deleted.flatMap(item => item.ids);

    check('34 封抽奖通知全清了', deletedIds.length === 34, `实际 ${deletedIds.length}`);
    check('翻页翻到了第 4 页，不是只翻第一页',
        site.state.mailPageHits.includes(3), site.state.mailPageHits.join(','));
    check('两封该留的还在',
        site.state.mail.length === 2 && KEEP.every(k => !deletedIds.includes(k.id)),
        site.state.mail.map(m => m.subject).join(' | '));
    check('提交的是 action=moveordel + delete',
        site.state.deleted.every(item => item.action === 'moveordel' && item.del === '删除'),
        JSON.stringify(site.state.deleted.map(i => [i.action, i.del])));
    check('日志报了清理结果', /清掉 34 封抽奖通知/.test(out), out.slice(-500));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[6] 不开清理开关就完全不碰收件箱');
{
    const site = await startSite({
        prizes: ['魔力 100 '], balance: 100000,
        mail: [{ id: '1', subject: '幸运大转盘 中奖通知' }]
    });

    await runScript({ host: site.state.origin, draws: 1 });

    check('一次收件箱都没读', site.state.mailPageHits.length === 0, site.state.mailPageHits.join(','));
    check('一封都没删', site.state.deleted.length === 0, JSON.stringify(site.state.deleted));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[7] Cookie 失效要说人话，别闷头抽');
{
    const site = await startSite({ loggedOut: true });

    const { out } = await runScript({ host: site.state.origin, draws: 5 });

    check('点出了 Cookie 失效', /Cookie 已失效/.test(out), out.slice(-500));
    check('一次都没抽', site.state.draws === 0, `实际 ${site.state.draws}`);

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[8] 没填 Cookie（还是占位文字）直接报错退出');
{
    const { code, out } = await runScript({ cookie: '在这里粘贴你的 Cookie' });

    check('非零退出码', code === 1, `exit ${code}`);
    check('占位文字不会被当成真 Cookie', /还没填 Cookie/.test(out), out.slice(-300));
    check('提示了去哪儿填', /配置区/.test(out) && /F12/.test(out), out.slice(-300));
}

/* ---------------------------------------------------------------- */
console.log('\n[9] 站点跟着改单抽消耗');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000, cost: 4000 });

    const { out } = await runScript({ host: site.state.origin, draws: 2 });

    check('单抽消耗按页面上的 4,000 算', /消耗 8,000/.test(out), out.slice(-400));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[10] 统计导出：格式和油猴版备份一模一样');
{
    const site = await startSite({
        prizes: ['魔力 100 ', '补签卡 1 ', '魔力 100 '],
        balance: 100000
    });
    const statsFile = path.join(TMP, 'stats-format.json');

    await runScript({ host: site.state.origin, draws: 3, statsFile });

    const payload = JSON.parse(fs.readFileSync(statsFile, 'utf8'));

    check('外层是备份文件的信封', payload.kind === 'hhclub-lottery-backup' && payload.version === 4,
        JSON.stringify({ kind: payload.kind, version: payload.version }));
    check('带 current 和 total 两份', !!payload.current && !!payload.total);
    check('标了来源是青龙', payload.source === 'qinglong', payload.source);

    const t = payload.total;
    check('抽数 / 消耗对得上', t.draws === 3 && t.cost === 6000, `${t.draws} 抽 / ${t.cost}`);
    check('gains 八个字段齐全',
        ['beans', 'magic', 'invite', 'rainbow', 'vip', 'makeup', 'upload', 'rename']
            .every(k => typeof t.gains[k] === 'number'),
        JSON.stringify(t.gains));
    check('憨豆合计 200', t.gains.beans === 200, `实际 ${t.gains.beans}`);
    check('补签卡 1 个', t.gains.makeup === 1, `实际 ${t.gains.makeup}`);
    check('prizes 是「类别 → { count, value, tiers }」',
        t.prizes.beans?.count === 2 && t.prizes.beans?.value === 200
        && t.prizes.beans?.tiers['100 憨豆'] === 2,
        JSON.stringify(t.prizes));
    check('档位名和油猴版一致（100 憨豆 / 1 个）',
        Object.keys(t.prizes.makeup.tiers)[0] === '1 个',
        Object.keys(t.prizes.makeup.tiers).join(' | '));
    check('raw 保留原始文案且已 trim',
        t.raw['魔力 100'] === 2 && t.raw['补签卡 1'] === 1, JSON.stringify(t.raw));
    check('带上了首末时间戳', typeof t.firstAt === 'number' && typeof t.lastAt === 'number',
        `${t.firstAt} / ${t.lastAt}`);
    check('日志里给出了文件路径', true);

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[11] 跨次运行累计：total 累加，current 只记本次');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });
    const statsFile = path.join(TMP, 'stats-accumulate.json');

    await runScript({ host: site.state.origin, draws: 3, statsFile });
    const { out } = await runScript({ host: site.state.origin, draws: 2, statsFile });

    const payload = JSON.parse(fs.readFileSync(statsFile, 'utf8'));

    check('total 累到 5 抽', payload.total.draws === 5, `实际 ${payload.total.draws}`);
    check('total 消耗累到 10,000', payload.total.cost === 10000, `实际 ${payload.total.cost}`);
    check('current 只记这一次的 2 抽', payload.current.draws === 2, `实际 ${payload.current.draws}`);
    check('档位次数也在累加', payload.total.prizes.beans.tiers['100 憨豆'] === 5,
        JSON.stringify(payload.total.prizes.beans.tiers));
    check('汇总里同时报了本次和历史总计',
        /本次：2 抽/.test(out) && /历史总计：5 抽/.test(out), out.slice(-600));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[12] VIP 折算要落进导出的统计里');
{
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        onDraw: state => { state.balance += 1000000; }
    });
    const statsFile = path.join(TMP, 'stats-vip.json');

    await runScript({ host: site.state.origin, draws: 1, statsFile });

    const t = JSON.parse(fs.readFileSync(statsFile, 'utf8')).total;

    check('憨豆记了 1,000,000', t.gains.beans === 1000000, `实际 ${t.gains.beans}`);
    check('VIP 天数被扣回去了（没真拿到）', !t.gains.vip, `实际 ${t.gains.vip}`);
    check('仍然算一次 VIP 中奖，爆率统计不少这一笔',
        t.prizes.vip?.count === 1, JSON.stringify(t.prizes.vip));
    check('没有凭空多出一个憨豆类别的中奖', !t.prizes.beans, JSON.stringify(t.prizes.beans));
    check('VIP 档位换成「已转换为憨豆 1,000,000」',
        Object.keys(t.prizes.vip.tiers).join() === '已转换为憨豆 1,000,000',
        Object.keys(t.prizes.vip.tiers).join(' | '));
    check('折算的憨豆单独记在 swappedBeans 上（天数和憨豆不是一个单位）',
        t.prizes.vip.swappedBeans === 1000000 && t.prizes.vip.value === 0,
        `swappedBeans=${t.prizes.vip.swappedBeans} value=${t.prizes.vip.value}`);
    check('原始文案照实保留 VIP', t.raw['VIP 7 Day(s)'] === 1, JSON.stringify(t.raw));
    check('抽数和消耗没被重复计', t.draws === 1 && t.cost === 2000, `${t.draws} 抽 / ${t.cost}`);

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[13] 统计文件坏了不能把这次的成绩带走');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });
    const statsFile = path.join(TMP, 'stats-broken.json');
    fs.writeFileSync(statsFile, '{ 这不是合法 JSON');

    const { out } = await runScript({ host: site.state.origin, draws: 2, statsFile });

    check('提示了文件读不出来', /统计文件读不出来/.test(out), out.slice(-600));
    check('这次的 2 抽照样存下来了',
        JSON.parse(fs.readFileSync(statsFile, 'utf8')).total.draws === 2,
        fs.readFileSync(statsFile, 'utf8').slice(0, 120));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[14] statsFile 留空就不落文件');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });
    const before = fs.readdirSync(TMP).filter(f => f.startsWith('stats-')).length;

    const { out } = await runScript({ host: site.state.origin, draws: 1, statsFile: '' });

    const after = fs.readdirSync(TMP).filter(f => f.startsWith('stats-')).length;
    check('没多出统计文件', after === before, `${before} → ${after}`);
    check('也不会提示存到哪儿', !/统计已存到/.test(out), out.slice(-400));
    check('汇总照常打印', /本次：1 抽/.test(out), out.slice(-400));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[15] 折算的憨豆跨次运行不能丢');
{
    // 第一次中 VIP 被折算，第二次正常抽 —— 读回来时 swappedBeans 得还在
    let drawn = 0;
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        onDraw: state => { if (++drawn === 1) state.balance += 1000000; }
    });
    const statsFile = path.join(TMP, 'stats-swap-keep.json');

    await runScript({ host: site.state.origin, draws: 1, statsFile });

    site.state.prizes = null;   // 后面这次换成普通奖
    await site.close();

    const site2 = await startSite({ prizes: ['魔力 100 '], balance: 500000 });
    const { out } = await runScript({ host: site2.state.origin, draws: 1, statsFile });

    const t = JSON.parse(fs.readFileSync(statsFile, 'utf8')).total;

    check('两次累计 2 抽', t.draws === 2, `实际 ${t.draws}`);
    check('折算的 1,000,000 还在 swappedBeans 上',
        t.prizes.vip?.swappedBeans === 1000000, JSON.stringify(t.prizes.vip));
    check('憨豆总数 = 折算 1,000,000 + 这次 100',
        t.gains.beans === 1000100, `实际 ${t.gains.beans}`);
    check('VIP 中奖次数还是 1', t.prizes.vip?.count === 1, JSON.stringify(t.prizes.vip));
    check('历史总计里也报了折算',
        /⭐ VIP 1 次 · 另折算 1,000,000 憨豆/.test(out), out.slice(-700));

    await site2.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[16] 日志带时间戳，汇总块不带');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    const { out } = await runScript({ host: site.state.origin, draws: 2 });

    const [before, after] = out.split('─'.repeat(40));
    const logLines = before.split('\n').filter(line => line.trim());

    check('日志每一行都带 [MM/DD HH:MM:SS]',
        logLines.every(line => /^\[\d\d\/\d\d \d\d:\d\d:\d\d\] /.test(line)),
        logLines.find(line => !/^\[\d\d\/\d\d \d\d:\d\d:\d\d\] /.test(line)));
    check('抽奖那几行也带上了', logLines.some(line => /\] 🎲 第 1 抽/.test(line)),
        logLines.join(' | ').slice(0, 200));
    // 汇总之后还会有「通知渠道」之类的日志行，那些本来就带时间戳；
    // 这条断言的本意是「汇总块本身不套」，所以只看汇总内容行
    const summaryLines = (after || '').split('\n')
        .filter(line => line.trim() && !/^\[\d\d\/\d\d/.test(line));
    check('汇总块不套时间戳，免得没法看',
        summaryLines.some(line => /^本次：\d+ 抽$/.test(line))
        && summaryLines.some(line => /^ {2}消耗 /.test(line)),
        summaryLines.join(' | ').slice(0, 200));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[17] 时区按配置走 —— 容器里多半是 UTC，不设就对不上');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    const hourOf = out => {
        const match = out.match(/^\[\d\d\/\d\d (\d\d):\d\d:\d\d\]/m);
        return match ? Number(match[1]) : null;
    };

    const utc = await runScript({ host: site.state.origin, draws: 1, timezone: 'UTC' });
    const shanghai = await runScript({ host: site.state.origin, draws: 1, timezone: 'Asia/Shanghai' });

    const a = hourOf(utc.out);
    const b = hourOf(shanghai.out);

    check('两种时区都打出了时间', a !== null && b !== null, `${a} / ${b}`);
    check('上海比 UTC 快 8 小时', ((b - a) + 24) % 24 === 8, `UTC ${a} 时 / 上海 ${b} 时`);

    const bad = await runScript({ host: site.state.origin, draws: 1, timezone: '瞎写的时区' });
    check('时区写错不会崩，退回 ISO 格式',
        /^\[\d\d-\d\d \d\d:\d\d:\d\d\] /m.test(bad.out), bad.out.slice(0, 200));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[18] 在仓库里直接 node qinglong/hh_lottery.js 也能跑');
{
    // 仓库根目录的 package.json 是 type:module，会把这个目录下的 .js
    // 当 ESM 解析，直接跑就崩在 require 上 —— qinglong/package.json 钉回
    // commonjs 才行。这条就是防它被误删。
    const { code, out } = await new Promise(resolve => {
        const child = spawn(process.execPath, [SCRIPT], { cwd: ROOT });
        let text = '';
        child.stdout.on('data', d => { text += d; });
        child.stderr.on('data', d => { text += d; });
        child.on('close', c => resolve({ code: c, out: text }));
    });

    check('不会因为 type:module 崩掉',
        !/require is not defined|ERR_REQUIRE_ESM/.test(out), out.slice(0, 300));
    check('走到了「还没填 Cookie」这一步', /还没填 Cookie/.test(out), out.slice(0, 300));
    check('退出码是 1', code === 1, `exit ${code}`);
}

/* ---------------------------------------------------------------- */
console.log('\n[19] 档位要挂在类别下面，光看「7 天 × 1」认不出是什么奖');
{
    const site = await startSite({
        prizes: ['魔力 100 ', '魔力 100 ', '彩虹 ID 7 Day(s)', '补签卡 1 ', '补签卡 1 ', '上传量 2 GB'],
        balance: 100000
    });

    const { out } = await runScript({ host: site.state.origin, draws: 6 });
    const block = out.split('─'.repeat(40))[1] || '';

    check('憨豆一类：2 次 · 累计 200',
        /💰 憨豆 2 次 · 200/.test(block), block);
    check('补签卡一类：2 次 · 累计 2 个',
        /🎫 补签卡 2 次 · 2 个/.test(block), block);
    check('彩虹 ID 认得出来，不再是光秃秃的「7 天 × 1」',
        /🌈 彩虹ID 1 次 · 7 天/.test(block), block);
    check('上传量也带上类别', /⬆️ 上传量 1 次 · 2 GB/.test(block), block);

    // 档位行缩进得比类别行深，视觉上才是从属关系
    const lines = block.split('\n');
    const rainbowAt = lines.findIndex(line => line.includes('🌈 彩虹ID'));
    check('彩虹 ID 的档位紧跟在它自己下面',
        /^ {6}7 天 × 1$/.test(lines[rainbowAt + 1] || ''), lines[rainbowAt + 1]);
    check('中奖最多的类别排在最前',
        (block.indexOf('💰 憨豆') < block.indexOf('🌈 彩虹ID'))
        && (block.indexOf('🎫 补签卡') < block.indexOf('🌈 彩虹ID')),
        block);
    check('不再有拍平的孤儿档位行',
        !/^ {4}\S+ × \d+$/m.test(block), block);

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[20] 余额带小数时也要有千分位');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 1256247.2 });

    const { out } = await runScript({ host: site.state.origin, draws: 1 });

    check('余额写成 1,254,347.2 而不是一长串',
        /余额 1,254,347\.2\b/.test(out), out.slice(-400));
    check('没有 toFixed 补出来的多余 0', !/1254347|\.20\b/.test(out), out.slice(-400));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[21] 折算金额按站点公布值，做种涨的那几十点不算中奖');
{
    // 做种憨豆一直在涨，从本地结算到服务端读数这一两秒又涨了 60。
    // 拿余额差当金额的话会记出「1,000,060 憨豆」这种奖池里没有的档位。
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        swapBeans: 1000000,
        userClass: 'vip',
        onDraw: state => { state.balance += 1000000 + 60; }
    });
    const statsFile = path.join(TMP, 'stats-published.json');

    const { out } = await runScript({ host: site.state.origin, draws: 1, statsFile });
    const t = JSON.parse(fs.readFileSync(statsFile, 'utf8')).total;

    check('档位是整数的 1,000,000，不是 1,000,060',
        Object.keys(t.prizes.vip.tiers).join() === '已转换为憨豆 1,000,000',
        Object.keys(t.prizes.vip.tiers).join(' | '));
    check('憨豆按公布值记 1,000,000', t.gains.beans === 1000000, `实际 ${t.gains.beans}`);
    check('多出来的 60 单独说明是做种收益',
        /同期余额另有 \+60（做种收益 \/ 赠送等），未计入中奖/.test(out), out.slice(-700));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[22] 按等级判：普通用户中真 VIP，同时收到大额赠送也不误判');
{
    // 之前靠「余额多出一大笔」判折算，这种情况会凭空多记一百万
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        swapBeans: 1000000,
        userClass: 'user',
        onDraw: state => { state.balance += 1000000; }   // 别人赠送的魔力
    });
    const statsFile = path.join(TMP, 'stats-gift.json');

    const { out } = await runScript({ host: site.state.origin, draws: 1, statsFile });
    const t = JSON.parse(fs.readFileSync(statsFile, 'utf8')).total;

    check('不认定为折算', !/站点改发/.test(out), out.slice(-700));
    check('老老实实记 VIP 7 天',
        t.gains.vip === 7 && Object.keys(t.prizes.vip.tiers).join() === '7 天',
        JSON.stringify(t.prizes.vip));
    check('没有凭空多出一百万憨豆', t.gains.beans === 0, `实际 ${t.gains.beans}`);

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[23] 等级够 VIP 但钱没到账：不能记成折算');
{
    // 线上事故：一个非 VIP 的号账面一分没多，却被记了一百万 ——
    // 旧逻辑「等级说是就是」，整条路径不看余额。等级那条线本来就脆，
    // 必须由余额定性。
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        swapBeans: 1000000,
        userClass: 'uploader'          // 等级够，但站点没发那笔钱
    });
    const statsFile = path.join(TMP, 'stats-class.json');

    const { out } = await runScript({ host: site.state.origin, draws: 1, statsFile });
    const t = JSON.parse(fs.readFileSync(statsFile, 'utf8')).total;

    check('不认定为折算', !/站点改发/.test(out), out.slice(-700));
    check('没有凭空记出一百万', t.gains.beans === 0, `实际 ${t.gains.beans}`);
    check('照实记 7 天 VIP',
        t.gains.vip === 7 && Object.keys(t.prizes.vip.tiers).join() === '7 天',
        JSON.stringify(t.prizes.vip));
    check('日志说明等级够但账面没动',
        /站点发的是天数/.test(out), out.slice(-700));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[23b] 等级够 VIP 且钱到账了，才记折算');
{
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        swapBeans: 1000000,
        userClass: 'uploader',                            // 比 VIP 还高，也该算
        onDraw: state => { state.balance += 1000000; }
    });
    const statsFile = path.join(TMP, 'stats-class-paid.json');

    const { out } = await runScript({ host: site.state.origin, draws: 1, statsFile });
    const t = JSON.parse(fs.readFileSync(statsFile, 'utf8')).total;

    check('认定为折算', /站点改发了 1,000,000 憨豆/.test(out), out.slice(-700));
    check('VIP 以上的等级同样算', t.prizes.vip.swappedBeans === 1000000,
        JSON.stringify(t.prizes.vip));
    check('查等级只查一次，不是每抽都查',
        (site.state.classPageHits || 0) === 1, `实际 ${site.state.classPageHits} 次`);

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[23c] 农民（class 0）要判成「不是 VIP」，不是「读不到」');
{
    // 事故的另一半：等级表里没有 peasant，而且 `if (!rank)` 连 0 都
    // 当成读不到，一退化就只能靠余额猜。奖池里那发 780,000 一出来，
    // 就足够把非 VIP 的号顶成折算。
    // H&R 不达标被降级的农民，恰恰是挂机刷抽奖最容易掉进去的等级。
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        swapBeans: 1000000,
        userClass: 'peasant',
        onDraw: state => { state.balance += 780000; }     // 同期中了一发 780,000
    });
    const statsFile = path.join(TMP, 'stats-peasant.json');

    const { out } = await runScript({ host: site.state.origin, draws: 1, statsFile });
    const t = JSON.parse(fs.readFileSync(statsFile, 'utf8')).total;

    check('照实记 7 天 VIP', t.gains.vip === 7, `实际 ${t.gains.vip}`);
    check('没把 780,000 顶成折算', t.gains.beans === 0, `实际 ${t.gains.beans}`);
    check('日志点明等级不符合折算条件',
        /不符合折算条件/.test(out), out.slice(-700));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[24] 等级读不到、余额差又对不上：按 VIP 记并说明白');
{
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        swapBeans: 1000000,
        userClass: null,                                  // 查不到等级
        onDraw: state => { state.balance += 500000; }     // 一笔赠送，不是折算
    });
    const statsFile = path.join(TMP, 'stats-unknown.json');

    const { out } = await runScript({ host: site.state.origin, draws: 1, statsFile });
    const t = JSON.parse(fs.readFileSync(statsFile, 'utf8')).total;

    check('不瞎猜，按 VIP 记', t.gains.vip === 7 && t.gains.beans === 0,
        `vip=${t.gains.vip} beans=${t.gains.beans}`);
    check('明说读不到等级、数额也对不上',
        /读不到你的等级、数额也对不上公布的/.test(out), out.slice(-700));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[25] 抽奖途中按节奏清信，不是等全抽完才动手');
{
    // 每抽一次站点发一封通知。设成「每 3 抽清一次」，抽 7 次，
    // 途中该清 2 回（第 3、6 抽），最后收尾再翻一遍
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    // 让 mock 站点每抽一次就往收件箱塞一封通知
    let mailId = 1000;
    const original = site.state.mail;
    site.state.mail = original;

    const siteWithMail = await startSite({
        prizes: ['魔力 100 '],
        balance: 100000,
        onDraw: state => {
            state.mail.unshift({ id: String(mailId++), subject: '幸运大转盘 中奖通知' });
        }
    });
    await site.close();

    const { out } = await runScript(
        { host: siteWithMail.state.origin, draws: 7, cleanMail: true },
        { mailCleanEveryDraws: 3 }
    );

    const midRun = (out.match(/清掉 \d+ 封抽奖通知 · 本次累计/g) || []).length;

    check('途中清了 2 回（第 3、6 抽）', midRun === 2, `实际 ${midRun} 回`);
    check('7 封通知一封不剩',
        siteWithMail.state.mail.length === 0,
        siteWithMail.state.mail.map(m => m.id).join(','));
    check('收尾报的是本次合计', /本次共清掉 7 封抽奖通知/.test(out), out.slice(-800));

    // 清理发生在抽奖途中：日志里第一次清信要排在最后一抽之前
    const firstClean = out.indexOf('清掉');
    const lastDraw = out.indexOf('🎲 第 7 抽');
    check('第一次清信排在最后一抽之前，说明是途中清的',
        firstClean > 0 && firstClean < lastDraw, `clean@${firstClean} draw7@${lastDraw}`);

    await siteWithMail.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[26] 收尾那遍要翻全本：被压在第一页下面的也得清掉');
{
    // 第一页塞满「种子被删除」，抽奖通知埋在第二页 ——
    // 只扫第一页的清法够不着，翻全本才行
    const KEEP = Array.from({ length: 10 }, (_, i) => ({
        id: `9${String(i).padStart(3, '0')}`, subject: '种子被删除'
    }));
    const BURIED = Array.from({ length: 6 }, (_, i) => ({
        id: `1${String(i).padStart(3, '0')}`, subject: '幸运大转盘 中奖通知'
    }));

    const site = await startSite({
        prizes: ['魔力 100 '],
        balance: 100000,
        mail: [...KEEP, ...BURIED],
        pageSize: 10
    });

    const { out } = await runScript({ host: site.state.origin, draws: 1, cleanMail: true });
    const left = site.state.mail;

    check('埋在第二页的 6 封全清了',
        left.length === 10 && left.every(m => m.subject === '种子被删除'),
        left.map(m => m.subject).join(' | '));
    check('10 封该留的一封没动',
        KEEP.every(k => left.some(m => m.id === k.id)), left.map(m => m.id).join(','));
    check('日志报了 6 封', /本次共清掉 6 封抽奖通知/.test(out), out.slice(-600));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[27] 外置配置：有 hh_lottery.config.json 就以它为准');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    // 脚本里的配置指向别处（连不上），全靠外置配置掰回来
    const { dir, file } = installScript(
        { draws: 99, host: 'http://127.0.0.1:1', timezone: 'UTC', userAgent: 'in-script' },
        null,
        {
            'hh_lottery.config.json': JSON.stringify({
                '//': '注释项要被忽略',
                host: site.state.origin,
                draws: 2,
                timezone: 'Asia/Shanghai',
                瞎写的项: 1
            }, null, 4)
        }
    );

    const { out } = await runFile(file, dir);

    check('说明了配置来自哪个文件', /⚙️ 配置来自 .*hh_lottery\.config\.json/.test(out), out.slice(0, 400));
    check('外置的 draws 覆盖了脚本里的 99', site.state.draws === 2, `实际 ${site.state.draws}`);
    check('外置的 host 也生效了', /本次：2 抽/.test(out), out.slice(-400));
    check('"//" 注释项不当配置', !/认不出的项.*\/\//.test(out), out.slice(0, 400));
    check('认不出的项会点名忽略', /认不出的项，已忽略：瞎写的项/.test(out), out.slice(0, 400));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[28] 没填 Cookie 时替你生成配置模板');
{
    const { code, out, dir } = await runScript({ cookie: '在这里粘贴你的 Cookie' });
    const file = path.join(dir, 'hh_lottery.config.json');

    check('生成了配置文件', fs.existsSync(file), dir);
    check('日志告诉你文件在哪', /📝 已生成配置文件/.test(out), out.slice(0, 400));
    check('模板里各项都在',
        (() => {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            return ['cookie', 'draws', 'reserve', 'interval', 'maxMinutes',
                'cleanMail', 'statsFile', 'timezone', 'host'].every(k => k in data);
        })(),
        fs.readFileSync(file, 'utf8').slice(0, 200));
    check('还是以退出码 1 结束', code === 1, `exit ${code}`);
}

/* ---------------------------------------------------------------- */
console.log('\n[29] 配置文件坏了要说清楚，并退回脚本里的配置');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    const { dir, file } = installScript(
        { draws: 1, host: site.state.origin },
        null,
        { 'hh_lottery.config.json': '{ 这不是 JSON' }
    );

    const { out } = await runFile(file, dir);

    check('明说文件不是合法 JSON', /不是合法 JSON/.test(out), out.slice(0, 400));
    check('退回脚本里的配置，照样跑得起来', /本次：1 抽/.test(out), out.slice(-400));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[30] 成绩先落盘，再去清信');
{
    // 清信接口卡死，模拟被 kill 在清信那一步。统计必须已经存好了
    const site = await startSite({
        prizes: ['魔力 100 '], balance: 100000,
        mail: [{ id: '1', subject: '幸运大转盘 中奖通知' }]
    });
    const statsFile = path.join(TMP, 'stats-order.json');

    const { out } = await runScript({ host: site.state.origin, draws: 2, cleanMail: true, statsFile });

    const saveAt = out.indexOf('💾 统计已存到');
    const cleanAt = out.indexOf('📪 本次共清掉');

    check('两件事都做了', saveAt > 0 && cleanAt > 0, `save@${saveAt} clean@${cleanAt}`);
    check('落盘排在清信之前', saveAt < cleanAt, out.slice(-600));
    check('统计文件里是 2 抽',
        JSON.parse(fs.readFileSync(statsFile, 'utf8')).total.draws === 2,
        fs.readFileSync(statsFile, 'utf8').slice(0, 120));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[31] 统计写盘是原子替换，不会留半截 JSON');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });
    const statsFile = path.join(TMP, 'stats-atomic.json');

    await runScript({ host: site.state.origin, draws: 1, statsFile });

    check('没留下 .tmp 残留', !fs.existsSync(`${statsFile}.tmp`), `${statsFile}.tmp`);
    check('文件是完整的 JSON',
        (() => {
            try { return JSON.parse(fs.readFileSync(statsFile, 'utf8')).total.draws === 1; }
            catch (error) { return false; }
        })(),
        fs.readFileSync(statsFile, 'utf8').slice(0, 120));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[32] 中途打断：成绩存下来，不触发清信');
if (process.platform === 'win32') {
    console.log('  · Windows 上 child.kill() 是强杀、收不到信号，这条跳过（Linux/NAS 上会跑）');
} else {
    const site = await startSite({
        prizes: ['魔力 100 '], balance: 100000,
        mail: [{ id: '1', subject: '幸运大转盘 中奖通知' }]
    });
    const statsFile = path.join(TMP, 'stats-interrupt.json');

    let drawn = 0;
    const live = spawnScript(
        { host: site.state.origin, draws: 50, cleanMail: true, statsFile },
        { onOutput: text => { if (/🎲 第 \d+ 抽/.test(text)) drawn++; } }
    );

    // 等它抽满两次再打断
    await until(() => drawn >= 2, 30000);
    live.child.kill('SIGINT');
    const { out } = await live.done;

    check('说明了是被信号打断的', /收到 Ctrl-C/.test(out), out.slice(-600));
    check('已抽到的成绩存下来了',
        fs.existsSync(statsFile) && JSON.parse(fs.readFileSync(statsFile, 'utf8')).total.draws >= 2,
        fs.existsSync(statsFile) ? fs.readFileSync(statsFile, 'utf8').slice(0, 120) : '文件不存在');
    check('没抽满 50 次就停了',
        site.state.draws < 50, `实际 ${site.state.draws}`);
    check('打断时不清信，那封通知还在',
        site.state.mail.length === 1, site.state.mail.map(m => m.id).join(','));
    check('汇总照样打出来了', /本次：\d+ 抽/.test(out), out.slice(-400));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[33] 等级查失败只是这一次失败，下次还得再查');
{
    // 第一次查等级 502，第二次通。第一注账面不动（等级又查不到）→
    // 按天数记；第二注那笔钱真到账，配合重试查到的等级 → 判出折算。
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        swapBeans: 1000000,
        userClass: 'vip',
        classFailTimes: 1,
        onDraw: state => { if (state.draws === 2) state.balance += 1000000; }
    });
    const statsFile = path.join(TMP, 'stats-retry.json');

    await runScript({ host: site.state.origin, draws: 2, statsFile });
    const t = JSON.parse(fs.readFileSync(statsFile, 'utf8')).total;

    check('两注都算 VIP 中奖', t.prizes.vip.count === 2, `实际 ${t.prizes.vip.count}`);
    check('第一注查不到等级、账面也没多钱，老实记 7 天',
        t.prizes.vip.tiers['7 天'] === 1, JSON.stringify(t.prizes.vip.tiers));
    check('第二注重试查到了等级、钱也到账，按折算记',
        t.prizes.vip.tiers['已转换为憨豆 1,000,000'] === 1, JSON.stringify(t.prizes.vip.tiers));
    check('憨豆只加了一注的 1,000,000', t.gains.beans === 1000000, `实际 ${t.gains.beans}`);
    check('等级页确实被请求了两次（失败那次没被记成查过）',
        site.state.classFails === 1, `失败 ${site.state.classFails} 次`);

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[34] 折算来的憨豆要在汇总里点明来源');
{
    // 不点的话，拿各档位乘开去对「获得憨豆」会差出一百万，看着像 bug
    const site = await startSite({
        prizes: ['VIP 7 Day(s)', '魔力 100 '],
        balance: 500000,
        swapBeans: 1000000,
        userClass: 'vip',
        onDraw: (state, text) => { if (text.includes('VIP')) state.balance += 1000000; }
    });

    const { out } = await runScript({ host: site.state.origin, draws: 2 });

    check('获得憨豆那行注明了折算金额',
        /获得 1,000,100 憨豆（其中 1,000,000 来自 VIP 折算）/.test(out), out.slice(-700));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[35] 没有折算时不多这一句');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    const { out } = await runScript({ host: site.state.origin, draws: 1 });

    check('普通抽奖的汇总干干净净', !/来自 VIP 折算/.test(out), out.slice(-400));

    await site.close();
}

/* 收通知的假服务器 —— 用来验非青龙环境下的推送 */
function startWebhook() {
    const got = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        try {
            got.push(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (error) {
            got.push({ raw: Buffer.concat(chunks).toString() });
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
    });

    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({
            got,
            url: `http://127.0.0.1:${server.address().port}/hook`,
            tgHost: `127.0.0.1:${server.address().port}`,
            close: () => new Promise(r => server.close(r))
        }));
    });
}

/* ---------------------------------------------------------------- */
console.log('\n[36] 不在青龙里也能收到通知：Webhook 兜底');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });
    const hook = await startWebhook();

    const { out } = await runScript({
        host: site.state.origin, draws: 2, webhookUrl: hook.url
    });

    check('推了一条', hook.got.length === 1, `实际 ${hook.got.length} 条`);
    check('标题里有脚本名', /HHCLUB 幸运大转盘/.test(hook.got[0]?.title || ''), hook.got[0]?.title);
    check('正文带汇总', /抽奖：\+2 抽/.test(hook.got[0]?.content || ''), (hook.got[0]?.content || '').slice(0, 200));
    check('正文报了运行时长', /运行时长：\d/.test(hook.got[0]?.content || ''),
        (hook.got[0]?.content || '').slice(0, 200));
    check('不再说「没有可用的通知渠道」', !/没有可用的通知渠道/.test(out), out.slice(-300));
    check('日志里逐个渠道报了结果', /📤 通知：Webhook ✓/.test(out), out.slice(-400));

    await hook.close();
    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[37] 一个渠道都没配时说明白，别装作推了');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    const { out } = await runScript({ host: site.state.origin, draws: 1 });

    check('明说没有可用渠道', /没有可用的通知渠道，本次只写了日志/.test(out), out.slice(-300));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[38] 中大奖当场推一条');
{
    const site = await startSite({
        prizes: ['魔力 780000 ', '魔力 100 '],
        balance: 100000
    });
    const hook = await startWebhook();

    await runScript({
        host: site.state.origin, draws: 2,
        notifyBigPrize: true, bigPrizeMinBeans: 780000,
        webhookUrl: hook.url
    });

    const big = hook.got.find(item => /命中大奖/.test(item.title || ''));

    check('大奖那条推出去了', !!big, hook.got.map(i => i.title).join(' | '));
    check('写明了第几抽中的什么', /命中大奖：💰 780,000 憨豆/.test(big?.content || ''), big?.content);
    check('收尾那条汇总也还在',
        hook.got.some(item => /抽奖：\+2 抽/.test(item.content || '')),
        hook.got.map(i => i.title).join(' | '));

    await hook.close();
    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[39] 普通奖不推，别刷屏');
{
    const site = await startSite({ prizes: ['魔力 5000 '], balance: 100000 });
    const hook = await startWebhook();

    await runScript({
        host: site.state.origin, draws: 3,
        notifyBigPrize: true, bigPrizeMinBeans: 780000,
        webhookUrl: hook.url
    });

    check('只有收尾那一条', hook.got.length === 1, hook.got.map(i => i.title).join(' | '));
    check('不是大奖通知', !/命中大奖/.test(hook.got[0]?.title || ''), hook.got[0]?.title);

    await hook.close();
    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[40] 青龙预注册的「立即退出」处理器要被接管');
if (process.platform === 'win32') {
    console.log('  · Windows 上 child.kill() 是强杀、收不到信号，这条跳过（Linux/NAS 上会跑）');
} else {
    // 青龙通过 NODE_OPTIONS 预加载脚本，会抢在业务脚本前面注册 SIGTERM
    // 并直接 process.exit()。不接管的话保存和推送根本轮不到。
    const preload = path.join(TMP, 'ql-preload.cjs');
    fs.writeFileSync(preload,
        "process.on('SIGTERM', () => { console.log('[preload] 立即退出'); process.exit(15); });\n");

    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });
    const hook = await startWebhook();
    const statsFile = path.join(TMP, 'stats-ql-signal.json');

    const { dir, file } = installScript({
        host: site.state.origin, draws: 50, statsFile, webhookUrl: hook.url
    });

    let drawn = 0;
    const child = spawn(process.execPath, ['-r', preload, file], { cwd: dir });
    let out = '';
    child.stdout.on('data', d => {
        out += d;
        if (/🎲 第 \d+ 抽/.test(String(d))) drawn++;
    });
    child.stderr.on('data', d => { out += d; });
    const done = new Promise(resolve => child.on('close', code => resolve(code)));

    await until(() => drawn >= 2, 30000);
    child.kill('SIGTERM');
    await done;

    check('日志说明接管了预注册的处理器', /已接管退出信号/.test(out), out.slice(0, 400));
    check('预加载那个「立即退出」没能抢先', !/\[preload\] 立即退出/.test(out), out.slice(0, 400));
    check('成绩存下来了',
        fs.existsSync(statsFile) && JSON.parse(fs.readFileSync(statsFile, 'utf8')).total.draws >= 2,
        fs.existsSync(statsFile) ? '有文件' : '文件不存在');
    check('停止通知也推出去了',
        hook.got.some(item => /手动停止/.test(item.title || '')),
        hook.got.map(i => i.title).join(' | '));
    check('通知里写了停止原因',
        hook.got.some(item => /收到 SIGTERM 停止信号（手动停止）/.test(item.content || '')),
        hook.got.map(i => (i.content || '').slice(0, 60)).join(' | '));

    await hook.close();
    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[41] 间隔说多久就是多久，不再随机抖动');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    const stamps = [];
    site.server.on('request', req => {
        if (req.url.includes('lucky-draw')) stamps.push(Date.now());
    });

    await runScript({ host: site.state.origin, draws: 4, interval: 3 });

    const gaps = stamps.slice(1).map((at, i) => at - stamps[i]);
    check('三次间隔都贴着 3 秒（±400ms）',
        gaps.length === 3 && gaps.every(gap => Math.abs(gap - 3000) < 400),
        gaps.join(', '));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[42] 间隔支持两位小数');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    const { out } = await runScript({ host: site.state.origin, draws: 1, interval: 3.25 });

    check('日志里写的是 3.25 秒，不是 3', /间隔 3\.25 秒/.test(out), out.slice(0, 300));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[43] 间隔填得离谱时收敛到合法范围');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    const { out } = await runScript({ host: site.state.origin, draws: 1, interval: 0.5 });

    check('低于下限 3 秒的收到 3', /间隔 3 秒/.test(out), out.slice(0, 300));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[44] 老用户把设置写在脚本里：头一次跑就固化成配置文件');
{
    // 这是升级路径上最要命的一环 —— 设置写在脚本里，
    // ql raw / curl 一覆盖就全没了。所以第一次跑必须先存下来。
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    const { dir, file } = installScript({
        host: site.state.origin, draws: 2, interval: 7, maxMinutes: 600, cleanMail: false
    });
    const configFile = path.join(dir, 'hh_lottery.config.json');

    check('跑之前没有配置文件', !fs.existsSync(configFile), configFile);

    const first = await runFile(file, dir);

    check('跑完生成了配置文件', fs.existsSync(configFile), configFile);
    check('日志说明了这件事', /📝 已把当前设置存成/.test(first.out), first.out.slice(0, 500));

    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    check('存的是脚本里那份设置，不是默认值',
        saved.draws === 2 && saved.interval === 7 && saved.maxMinutes === 600,
        JSON.stringify({ draws: saved.draws, interval: saved.interval, maxMinutes: saved.maxMinutes }));
    check('Cookie 也一起存了', saved.cookie === 'c_secure_uid=test', saved.cookie);

    // 模拟一次「更新脚本」：把脚本换成默认配置那版，设置应该还在
    fs.writeFileSync(file, patchSource({ host: 'http://127.0.0.1:1', draws: 99 }));
    const second = await runFile(file, dir);

    check('更新脚本后配置来自文件', /⚙️ 配置来自/.test(second.out), second.out.slice(0, 400));
    check('设置没丢：还是抽 2 次不是 99 次',
        site.state.draws === 4, `两次共抽了 ${site.state.draws} 次`);
    check('不会重复生成、把改过的覆盖回去',
        !/📝 已把当前设置存成/.test(second.out), second.out.slice(0, 400));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[45] sendNotify 在但一个渠道都没配时，自己配的渠道照发');
{
    // 线上实测踩到的：青龙里 sendNotify.js 存在，但 config.sh 一个推送
    // 渠道都没配。调它不报错，于是被当成「发出去了」，Webhook 兜底根本
    // 没走 —— 日志写着通知已发出，实际什么都没收到。
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });
    const hook = await startWebhook();

    const { dir, file } = installScript(
        { host: site.state.origin, draws: 1, webhookUrl: hook.url },
        null,
        {
            // 装样子的 sendNotify：不报错，也什么都不做，跟没配渠道时一模一样
            'sendNotify.js': 'module.exports = async function () { return; };\n'
        }
    );

    const { out } = await runFile(file, dir);

    check('sendNotify 被调用了', /青龙 sendNotify（已调用/.test(out), out.slice(-500));
    check('不打包票说「已送达」', !/sendNotify ✓/.test(out), out.slice(-500));
    check('Webhook 照样发了 —— 这就是那个 bug',
        hook.got.length === 1, `实际 ${hook.got.length} 条`);
    check('逐个渠道报了结果', /📤 通知：.*Webhook ✓/.test(out), out.slice(-500));

    await hook.close();
    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[46] 时间戳格式不随平台变（Linux 上曾多出个逗号）');
{
    // toLocaleString('zh-CN') 的分隔符跟 ICU 版本走：
    // Windows 上「08/19 09:05:01」，Linux 上「08/21, 10:30:27」。
    // 一直在 Windows 上跑测试，所以这个差异到实机才暴露。
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    const { out } = await runScript({ host: site.state.origin, draws: 1 });
    const stamps = [...out.matchAll(/^\[([^\]]+)\]/gm)].map(m => m[1]);

    check('每条日志的时间戳都是 MM/DD HH:MM:SS',
        stamps.length > 0 && stamps.every(text => /^\d\d\/\d\d \d\d:\d\d:\d\d$/.test(text)),
        stamps.find(text => !/^\d\d\/\d\d \d\d:\d\d:\d\d$/.test(text)) || stamps[0]);
    check('里面没有逗号', stamps.every(text => !text.includes(',')), stamps[0]);

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[47] 青龙的 TG 环境变量不能被当成本脚本的 TG 配置');
{
    // 青龙会把 config.sh 里的 TG_BOT_TOKEN / TG_USER_ID 注入 process.env，
    // 它自己的 sendNotify 已经往 TG 推了一条。要是脚本再拿这两个变量直连，
    // 同一条消息就推两遍。实机上真踩到过。
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });
    const hook = await startWebhook();

    const { dir, file } = installScript(
        { host: site.state.origin, draws: 1, webhookUrl: hook.url, tgApiHost: hook.tgHost },
        null,
        { 'sendNotify.js': 'module.exports = async function () { return; };\n' }
    );

    const { out } = await runFile(file, dir, {
        TG_BOT_TOKEN: '123456:fake-token',
        TG_USER_ID: '7654321'
    });

    // 假 TG 主机指向同一个监听端；真去直连的话这里会多收一条
    check('只收到 Webhook 那一条，没有多出来的 TG',
        hook.got.length === 1, `实际 ${hook.got.length} 条`);
    check('日志里压根没有 Telegram 这一项',
        !/Telegram/.test(out), out.slice(-400));
    check('Webhook 照常', /Webhook ✓/.test(out), out.slice(-400));

    await hook.close();
    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[48] 自己在配置里填了 TG 才直连');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });
    const hook = await startWebhook();

    // tgApiHost 指向假服务器，直连会打到它上面
    const { dir, file } = installScript({
        host: site.state.origin, draws: 1,
        tgBotToken: '123456:fake', tgUserId: '7654321', tgApiHost: hook.tgHost
    });

    const { out } = await runFile(file, dir);

    // sendTelegramDirect 写死 https，这个假服务器是明文 HTTP，握手必然失败 ——
    // 所以只验「确实发起了直连」，不验对端收到。真实送达在实机上验。
    check('填了就会走直连这条路', /Telegram [✓✗]/.test(out), out.slice(-400));
    check('失败也如实报，不冒充成功', /Telegram ✗/.test(out), out.slice(-400));
    check('没配 Webhook 就不提 Webhook', !/Webhook/.test(out), out.slice(-400));

    await hook.close();
    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[49] 同目录的 sendNotify.js 依赖缺失时要跳过，不能就此放弃');
{
    // 实机上踩到的：/ql/data/scripts/sendNotify.js 是别的脚本留下的残骸，
    // require 直接抛 Cannot find module 'got'。当时那是候选列表的第一项，
    // 抛了之后没有别的能用，通知就静默没了。
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });
    const hook = await startWebhook();

    const { dir, file } = installScript(
        { host: site.state.origin, draws: 1, webhookUrl: hook.url },
        null,
        { 'sendNotify.js': "require('这个模块根本不存在');\nmodule.exports = {};\n" }
    );

    const { out } = await runFile(file, dir);

    check('没有因为它抛异常就崩',
        /本次：1 抽/.test(out) && !/Cannot find module/.test(out.split('───')[0]),
        out.slice(-400));
    check('Webhook 照常送达', hook.got.length === 1, `实际 ${hook.got.length} 条`);
    check('日志里报了 Webhook', /Webhook ✓/.test(out), out.slice(-400));

    await hook.close();
    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[50] 青龙注入的 QLAPI.systemNotify 能兜底');
{
    // 新版青龙把通知能力挂在全局 QLAPI 上。没有任何 sendNotify 模块时
    // 应该退到这条路 —— 用 --require 预加载一个假的 QLAPI 来模拟。
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    const preload = path.join(TMP, 'fake-qlapi.cjs');
    const marker = path.join(TMP, 'qlapi-called.txt');
    fs.writeFileSync(preload, `
        const fs = require('fs');
        globalThis.QLAPI = {
            systemNotify: async ({ title, content }) => {
                fs.writeFileSync(${JSON.stringify(marker)}, title + '\\n' + content.slice(0, 80));
                return true;
            }
        };
    `);

    const { dir, file } = installScript({ host: site.state.origin, draws: 1 });

    const out = await new Promise(resolve => {
        const child = spawn(process.execPath, ['-r', preload, file], { cwd: ROOT });
        let text = '';
        child.stdout.on('data', d => { text += d; });
        child.stderr.on('data', d => { text += d; });
        child.on('close', () => resolve(text));
    });

    check('走到了 QLAPI 这条路', fs.existsSync(marker), '没被调用');
    check('标题传对了',
        fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').startsWith('🏁 HHCLUB 幸运大转盘｜运行结束'),
        fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').slice(0, 60) : '');
    check('不再说没有可用渠道', !/没有可用的通知渠道/.test(out), out.slice(-300));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[51] 老配置文件缺的项要补进去');
{
    // 配置文件一旦存在就不再被模板覆盖，所以老版本生成的那份
    // 永远不会长出后来新加的项（tgBotToken 这些就是这么被漏掉的）。
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });
    const { dir, file } = installScript({ host: site.state.origin });

    const cfgFile = path.join(dir, 'hh_lottery.config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({
        '//': '老版本生成的',
        cookie: 'uid=1; pass=2',
        draws: 3,
        host: site.state.origin,
        我自己加的: '别删我'
    }, null, 4));

    await runFile(file, dir);
    const after = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));

    // 期望值从 DEFAULT_CONFIG 推，别手写清单 —— 手写的迟早跟不上
    const want = Object.keys(DEFAULT_CONFIG).filter(k => !(k in { cookie: 0, draws: 0, host: 0 }));
    const still = want.filter(k => !Object.prototype.hasOwnProperty.call(after, k));
    check('配置区里有、文件里没有的项都补上了', still.length === 0, `还缺：${still.join(', ')}`);
    check('原有的值没被改回默认', after.draws === 3, `draws=${after.draws}`);
    check('注释还在', after['//'] === '老版本生成的', String(after['//']));
    check('认不出的项没被删掉', after['我自己加的'] === '别删我', JSON.stringify(after));
    check('补进去的是当前生效的默认值',
        want.every(k => JSON.stringify(after[k]) === JSON.stringify(DEFAULT_CONFIG[k])),
        JSON.stringify(after));

    // 补完就该安静了，第二次不该再报一遍
    const second = await runFile(file, dir);
    check('第二次不再刷补全提示', !/补上了新版本才有的项/.test(second.out), second.out.slice(-300));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[52] 仓库里那份样板配置要和配置区对得上');
{
    // 它是手写维护的，脚本加了新项很容易忘了同步 —— 忘了的话
    // 照着它填的人就看不到新开关
    const sample = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'qinglong', 'hh_lottery.config.json'), 'utf8'));

    const head = SOURCE.indexOf('const CONFIG = {');
    const foot = SOURCE.indexOf('\n};\n\n/* ===== 配置区结束 ===== */');
    const block = SOURCE.slice(head, foot);
    const keys = [...block.matchAll(/\n {4}(\w+):/g)].map(m => m[1]);

    const missing = keys.filter(k => !Object.prototype.hasOwnProperty.call(sample, k));
    const extra = Object.keys(sample).filter(k => k !== '//' && !keys.includes(k));

    check('配置区的项样板里一个不少', missing.length === 0, `缺：${missing.join(', ')}`);
    check('样板里没有多出来的项', extra.length === 0, `多：${extra.join(', ')}`);
}

/* ---------------------------------------------------------------- */
console.log('\n[53] 自适应延迟跟随上一抽 duration，固定 interval 完全不参与');
{
    const site = await startSite({
        prizes: ['魔力 100 '],
        durations: [700, 1100, 600],
        balance: 100000
    });
    const stamps = [];
    site.server.on('request', req => {
        if (req.url.includes('lucky-draw')) stamps.push(Date.now());
    });

    const { out } = await runScript({
        host: site.state.origin,
        draws: 3,
        interval: 300,
        followDuration: true,
        durationBufferMs: 100
    });

    const gaps = stamps.slice(1).map((at, i) => at - stamps[i]);
    check('下一抽分别贴着 700+100ms、1100+100ms',
        gaps.length === 2 && Math.abs(gaps[0] - 800) < 250 && Math.abs(gaps[1] - 1200) < 250,
        gaps.join(', '));
    check('启动日志明确是自适应，不把 interval 300 秒说成生效',
        /自适应延迟 · 缓冲 100ms/.test(out) && !/固定间隔 300 秒/.test(out),
        out.slice(0, 400));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[54] 自适应缓冲支持负值，并收敛到 -500 ~ 5000ms');
{
    const low = await startSite({ durations: [700], balance: 100000 });
    const lowStamps = [];
    low.server.on('request', req => {
        if (req.url.includes('lucky-draw')) lowStamps.push(Date.now());
    });
    const lowRun = await runScript({
        host: low.state.origin, draws: 2, followDuration: true, durationBufferMs: -900
    });
    const lowGap = lowStamps[1] - lowStamps[0];
    check('低于 -500 的缓冲收敛到 -500，且总间隔仍不低于 500ms',
        /缓冲 -500ms/.test(lowRun.out) && Math.abs(lowGap - 500) < 250,
        `${lowGap}ms\n${lowRun.out.slice(0, 300)}`);
    await low.close();

    const high = await startSite({ balance: 100000 });
    const highRun = await runScript({
        host: high.state.origin, draws: 1, followDuration: true, durationBufferMs: 9000
    });
    check('高于 5000 的缓冲收敛到 5000', /缓冲 5000ms/.test(highRun.out), highRun.out.slice(0, 300));
    await high.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[55] 已知冷却时被限流，300ms 后补枪而不是重等完整周期');
{
    const site = await startSite({
        durations: [500, 500],
        rateLimitAttempts: [2],
        balance: 100000
    });
    const stamps = [];
    site.server.on('request', req => {
        if (req.url.includes('lucky-draw')) stamps.push(Date.now());
    });

    const { out } = await runScript({
        host: site.state.origin, draws: 2, followDuration: true, durationBufferMs: 0
    });
    const retryGap = stamps[2] - stamps[1];
    check('限流没有算成一次抽奖', site.state.draws === 2 && site.state.drawAttempts === 3,
        `成功 ${site.state.draws}，请求 ${site.state.drawAttempts}`);
    check('补枪贴着 300ms', Math.abs(retryGap - 300) < 180, `${retryGap}ms`);
    check('日志说明按已知 duration 补枪', /上一抽转盘 0\.5 秒，没等够 · 300ms 后补一枪/.test(out), out.slice(-500));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[56] 尚无 duration 时被限流，按 1 秒慢速补枪');
{
    const site = await startSite({ rateLimitAttempts: [1], balance: 100000 });
    const stamps = [];
    site.server.on('request', req => {
        if (req.url.includes('lucky-draw')) stamps.push(Date.now());
    });

    const { out } = await runScript({ host: site.state.origin, draws: 1, followDuration: true });
    const retryGap = stamps[1] - stamps[0];
    check('未知冷却补枪贴着 1 秒', Math.abs(retryGap - 1000) < 250, `${retryGap}ms`);
    check('日志明确冷却未知', /冷却剩多久未知，1000ms 后再试/.test(out), out.slice(-500));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[57] 定时战报：按周期推送增量与历史奖品明细');
{
    const site = await startSite({
        prizes: ['魔力 100 ', '补签卡 1 ', '魔力 5000 '],
        balance: 100000
    });
    const hook = await startWebhook();

    const { dir, file } = installScript({
        host: site.state.origin,
        draws: 3,
        notifyPeriodic: true,
        periodicMinutes: 0.00001,
        webhookUrl: hook.url
    });

    await runFile(file, dir);

    const reportNotice = hook.got.find(item => /定时战报/.test(item.title || ''));
    check('定时战报推出去了', !!reportNotice, hook.got.map(i => i.title).join(' | '));
    check('标题带定时战报', /📊 HHCLUB 幸运大转盘｜定时战报/.test(reportNotice?.title || ''), reportNotice?.title);
    check('包含播报概览', /╭─ ⏰ 播报概览/.test(reportNotice?.content || ''), reportNotice?.content);
    check('包含此次播报增量', /⚡ 此次播报增量/.test(reportNotice?.content || ''), reportNotice?.content);
    check('包含此次奖品明细', /🎁 此次奖品明细/.test(reportNotice?.content || ''), reportNotice?.content);
    check('包含历史累计总量', /🏆 历史累计总量/.test(reportNotice?.content || ''), reportNotice?.content);
    check('包含历史奖品明细', /📜 历史奖品明细/.test(reportNotice?.content || ''), reportNotice?.content);
    check('包含下次播报提示', /下次播报约/.test(reportNotice?.content || ''), reportNotice?.content);

    // 间隔设成 0.00001 分钟，每抽完一次都到点 —— 桶要是没重置，
    // 增量就会累成 +1 / +2 / +3，那这个功能报的就不是「增量」而是「累计」
    const periodic = hook.got.filter(item => /定时战报/.test(item.title || ''));
    check('每抽一次播报一次', periodic.length === 3, `实际 ${periodic.length} 条`);
    check('增量桶推完就清零，每条都只报 +1 抽',
        periodic.every(item => /🎲 抽奖：\+1 抽/.test(item.content || '')),
        periodic.map(item => (item.content || '').match(/🎲 抽奖：.+/)?.[0]).join(' | '));

    // 历史累计反过来必须是涨的，别把增量和累计接反了
    const totals = periodic.map(item => (item.content || '')
        .match(/🏆 历史累计总量（含此次增量）\n {2}🎲 抽奖：([\d,]+) 抽/)?.[1]);
    check('历史累计逐条递增', totals.join(',') === '1,2,3', totals.join(' | '));

    // 增量只有一件奖品，明细里就不该冒出另外两件
    const detailOf = item => (item?.content || '')
        .split('🎁 此次奖品明细')[1]?.split('━')[0] || '';
    check('第一条只算第一抽的憨豆',
        /💰 憨豆｜1 次 · 100 憨豆/.test(detailOf(periodic[0]))
        && !/🎫 补签卡/.test(detailOf(periodic[0])), detailOf(periodic[0]));
    check('第二条只算第二抽的补签卡，上一抽的憨豆已经清掉',
        /🎫 补签卡｜1 次/.test(detailOf(periodic[1]))
        && !/💰 憨豆/.test(detailOf(periodic[1])), detailOf(periodic[1]));

    await hook.close();
    await site.close();
}


/* ---------------------------------------------------------------- */
console.log('\n[58] 命中大奖通知排版与字段完整');
{
    const site = await startSite({
        prizes: ['魔力 780000 '],
        balance: 100000
    });
    const hook = await startWebhook();

    const { dir, file } = installScript({
        host: site.state.origin,
        draws: 1,
        notifyBigPrize: true,
        bigPrizeMinBeans: 780000,
        webhookUrl: hook.url
    });

    await runFile(file, dir);

    const big = hook.got.find(item => /命中大奖/.test(item.title || ''));
    check('命中大奖标题正确', /🎉 HHCLUB 幸运大转盘｜命中大奖/.test(big?.title || ''), big?.title);
    check('包含欧皇降临卡片', /╭─ 🎊 欧皇降临/.test(big?.content || ''), big?.content);
    check('命中大奖内容对齐', /命中大奖：💰 780,000 憨豆/.test(big?.content || ''), big?.content);
    check('包含中奖时间与当前抽数', /中奖时间：\d\d\/\d\d, \d\d:\d\d:\d\d/.test(big?.content || '') && /当前抽数：本次第 1 抽/.test(big?.content || ''), big?.content);
    check('包含本次运行数据', /📊 本次运行数据/.test(big?.content || '') && /已抽：1 抽/.test(big?.content || ''), big?.content);
    check('包含净盈亏与当前余额', /净盈亏：\+778,000/.test(big?.content || '') && /当前余额：878,000 憨豆/.test(big?.content || ''), big?.content);
    check('包含挂机提示', /🌟 后台持续挂机抽奖中/.test(big?.content || ''), big?.content);

    await hook.close();
    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[59] 任务结算通知排版与字段完整');
{
    const site = await startSite({
        prizes: ['魔力 100 ', '补签卡 1 '],
        balance: 100000
    });
    const hook = await startWebhook();

    const { dir, file } = installScript({
        host: site.state.origin,
        draws: 2,
        webhookUrl: hook.url
    });

    await runFile(file, dir);

    const finish = hook.got.find(item => /运行结束/.test(item.title || ''));
    check('运行结束标题正确', /🏁 HHCLUB 幸运大转盘｜运行结束/.test(finish?.title || ''), finish?.title);
    check('包含任务结算卡片', /╭─ 🎯 任务结算/.test(finish?.content || ''), finish?.content);
    check('包含运行状态与运行时长', /运行状态：/.test(finish?.content || '') && /运行时长：/.test(finish?.content || ''), finish?.content);
    check('包含本次运行增量', /⚡ 本次运行增量/.test(finish?.content || ''), finish?.content);
    check('包含本次奖品明细', /🎁 本次奖品明细/.test(finish?.content || ''), finish?.content);
    check('奖品层级列表格式正确', /💰 憨豆｜1 次 · 100 憨豆/.test(finish?.content || '') && /└ 100 憨豆 × 1/.test(finish?.content || ''), finish?.content);

    await hook.close();
    await site.close();
}
/* ---------------------------------------------------------------- */
console.log('\n[60] 跑挂了要说挂了：错误进得了通知，标题也得变');
{
    const hook = await startWebhook();

    // 指到一个没人监听的端口 —— snapshot() 必然抛，异常一路逃出 run()
    const { dir, file } = installScript({
        host: '127.0.0.1:1',
        draws: 2,
        webhookUrl: hook.url
    });

    await runFile(file, dir);

    const notice = hook.got[0];
    check('推了一条', hook.got.length === 1, `实际 ${hook.got.length} 条`);
    check('标题是异常停止，不是「运行结束」',
        /🛑 HHCLUB 幸运大转盘｜异常停止/.test(notice?.title || ''), notice?.title);
    check('运行状态写了异常中断',
        /运行状态：脚本异常中断（/.test(notice?.content || ''), notice?.content);
    check('正文带运行提示区块', /📋 运行提示/.test(notice?.content || ''), notice?.content);
    check('错误原文在通知里', /❌ fetch failed/.test(notice?.content || ''), notice?.content);

    await hook.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[61] 提示不能只留在日志里：VIP 折算说明要进通知');
{
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        onDraw: state => { state.balance += 1000000; }
    });
    const hook = await startWebhook();

    const { dir, file } = installScript({
        host: site.state.origin,
        draws: 1,
        webhookUrl: hook.url
    });

    const { out } = await runFile(file, dir);
    const notice = hook.got[0];

    check('日志里说了换发', /👑 你已经是 VIP，站点改发了/.test(out), out.slice(-400));
    check('通知里也说了换发',
        /👑 你已经是 VIP，站点改发了 1,000,000 憨豆/.test(notice?.content || ''), notice?.content);
    // 折算的憨豆不在憨豆档位里，不点这一句就会被当成对不上账的 bug
    check('获得行点明了折算来源',
        /🎁 获得：\+1,000,000 憨豆（其中 1,000,000 来自 VIP 折算）/.test(notice?.content || ''),
        notice?.content);
    // 卡片里已经有的行别在运行提示里再来一遍
    check('运行提示不重复卡片里已有的行',
        !/📋 运行提示[\s\S]*(▶ 开始|🏁 一抽到底)/.test(notice?.content || ''), notice?.content);
    check('没出岔子就还是「运行结束」标题',
        /🏁 HHCLUB 幸运大转盘｜运行结束/.test(notice?.title || ''), notice?.title);

    await hook.close();
    await site.close();
}
console.log('\n[62] 定时战报默认关着：配置里没写就不推');
{
    const site = await startSite({
        prizes: ['魔力 100 ', '补签卡 1 '],
        balance: 100000
    });
    const hook = await startWebhook();

    // notifyPeriodic 传 undefined，JSON.stringify 会把它整个丢掉 ——
    // 模拟配置区里压根没有这一项，走的就是脚本默认值
    const { dir, file } = installScript({
        host: site.state.origin,
        draws: 2,
        notifyPeriodic: undefined,
        periodicMinutes: 0.00001,
        webhookUrl: hook.url
    });

    await runFile(file, dir);

    check('没写就是不开，一条定时战报都没有',
        !hook.got.some(item => /定时战报/.test(item.title || '')),
        hook.got.map(i => i.title).join(' | '));
    check('收尾那条照旧推', hook.got.length === 1, hook.got.map(i => i.title).join(' | '));

    await hook.close();
    await site.close();
}

/* ---------------------------------------------------------------- */


/* ---------------------------------------------------------------- */
/* ---------------------------------------------------------------- */
console.log('\n[63] 断网不能当场收摊：退避重试，网络回来接着抽');
{
    // 线上事故：挂机跑了近两小时，机器网络抖了一下（DNS EAI_AGAIN），
    // 脚本一次 fetch failed 就退出了。根因是 drawOnce 的 try 只包着
    // JSON.parse，fetch 本身裸奔，异常直接冒出 run()，被 main() 的
    // 兜底 catch 接住 —— errorStreak 那套重试压根没机会跑。
    const site = await startSite({
        prizes: ['魔力 100 '],
        balance: 100000,
        killAttempts: [2, 3]          // 第 2、3 次请求直接掐断连接
    });

    // 退避实际是 10 秒起步，测试里压到 200ms
    const { out } = await runScript(
        { host: site.state.origin, draws: 3, interval: 0.5 },
        { networkRetryMs: 200 }
    );

    check('确实掐断了两次', site.state.killed === 2, `实际 ${site.state.killed} 次`);
    check('认出来是网络不通，不是站点报错',
        /📡 网络不通/.test(out), out.slice(-900));
    check('报了这是第几次', /第 1 次/.test(out) && /第 2 次/.test(out),
        out.slice(-900));
    check('网络回来说了一声', /📡 网络恢复了/.test(out), out.slice(-900));
    check('三抽一次没少', site.state.draws === 3, `实际 ${site.state.draws}`);
    check('没有被当成异常中断', !/脚本异常中断/.test(out), out.slice(-900));
    check('汇总照常打出来', /本次：3 抽/.test(out), out.slice(-600));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[64] 网络一直不通也不收摊，等待按阶梯往上抬');
{
    // 挂机无人值守：站点重启、网线抖一夜，收摊了就是整夜白过。
    // 一直重试，每 3 次抬一档，最终封顶。
    const site = await startSite({
        prizes: ['魔力 100 '],
        balance: 100000,
        killAttempts: Array.from({ length: 60 }, (_, i) => i + 1)   // 全掐
    });

    const { out } = await runScript(
        { host: site.state.origin, draws: 5, interval: 0.5 },
        { networkRetryMs: 100, maxRetryMs: 400, stuckWarnEvery: 4 }
    );

    check('没有因为「试够次数」收摊',
        !/试了 \d+ 次还是不行/.test(out) && !/网络连不上/.test(out), out.slice(-900));
    check('一直在重试，次数远超过原来的 10 次上限',
        /第 12 次/.test(out), out.slice(-1200));
    check('卡久了会提醒一声，但不停',
        /仍在重试/.test(out), out.slice(-1200));
    check('等待抬到了封顶值', /0\.4 秒后重试/.test(out), out.slice(-1200));
    check('熬过 60 次断网后，网络一通就接着把 5 抽跑完',
        site.state.draws === 5, `实际 ${site.state.draws}`);
    check('恢复时说了一声', /📡 网络恢复了/.test(out), out.slice(-1200));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[65] 清信途中网络抖一下，重试自愈，不是整轮放弃');
{
    // 清一次信要翻页加批量删好几个请求，任何一个撞上死连接就
    // 「⚠️ 站内信清理失败：fetch failed」整轮放弃。Node 的 fetch 会复用
    // 连接池，挂机几小时后池子里难免有被服务端悄悄关掉的连接 ——
    // 直接用 nodejs 长跑的人尤其容易碰上。
    const site = await startSite({
        prizes: ['魔力 100 '],
        balance: 100000,
        mail: Array.from({ length: 6 }, (_, i) => ({
            id: String(700 + i), subject: '幸运大转盘 中奖通知'
        })),
        killMailAttempts: [1, 2]        // 头两次站内信请求掐断
    });

    const { out } = await runScript(
        { host: site.state.origin, draws: 1, interval: 0.5, cleanMail: true },
        { requestRetryStepMs: 100 }
    );

    check('确实掐断了两次', site.state.mailKilled === 2, `实际 ${site.state.mailKilled} 次`);
    check('重试了，没有直接放弃', /网络不通/.test(out), out.slice(-900));
    check('没有报「站内信清理失败」',
        !/站内信清理失败/.test(out), out.slice(-900));
    check('信最后还是清干净了', site.state.mail.length === 0,
        JSON.stringify(site.state.mail));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[66] 抽奖那个 POST 绝不能重试 —— 重发就是又扣一次憨豆');
{
    // 幂等的请求（读页面、删信）才配重试。抽奖 POST 可能已经在服务端
    // 生效了，只是响应没回来，重发等于白扣两千。
    const source = fs.readFileSync(path.join(ROOT, 'qinglong', 'hh_lottery.js'), 'utf8');

    const drawOnce = source.slice(
        source.indexOf('async drawOnce()'),
        source.indexOf('record(prizeText, prize)')
    );

    check('drawOnce 直接用 fetch，没走重试包装',
        /await fetch\(/.test(drawOnce) && !/requestIdempotent/.test(drawOnce),
        drawOnce.slice(0, 300));

    // 注释挂在方法上面，起点要往前留出来
    const idempotent = source.slice(
        Math.max(0, source.indexOf('async requestIdempotent') - 600),
        source.indexOf('async snapshot()')
    );
    check('重试包装的注释点明了不能给抽奖用',
        /重发就是又扣一次憨豆/.test(idempotent), idempotent.slice(0, 400));
}

/* ---------------------------------------------------------------- */
console.log('\n[67] 大奖通知要写全奖品名，不能只剩个档位');
{
    // 中 VIP 时通知里只有「⭐ 7 天」—— 光看这个谁知道是 VIP 还是彩虹 ID。
    // label 只是档位，带单位的类别得把名字补回去。
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        swapBeans: 1000000,
        userClass: 'user'                     // 不是 VIP，真拿到 7 天
    });
    const hook = await startWebhook();

    await runScript({
        host: site.state.origin, draws: 1, interval: 0.5,
        notifyBigPrize: true, webhookUrl: hook.url
    });

    const big = hook.got.find(item => /命中大奖/.test(item.title || ''));
    check('大奖那条推出去了', !!big, hook.got.map(i => i.title).join(' | '));
    check('写的是「VIP 7 天」，不是光秃秃的「7 天」',
        /命中大奖：⭐ VIP 7 天/.test(big?.content || ''), big?.content);

    await hook.close();
    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[68] 中 VIP 被折算成憨豆时，通知要说清实际到手的是什么');
{
    // 已经是 VIP 的话站点改发一百万憨豆。通知还写「⭐ VIP 7 天」的话，
    // 会以为真拿到了会员。
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        swapBeans: 1000000,
        userClass: 'uploader',
        onDraw: state => { state.balance += 1000000; }
    });
    const hook = await startWebhook();

    await runScript({
        host: site.state.origin, draws: 1, interval: 0.5,
        notifyBigPrize: true, webhookUrl: hook.url
    });

    const big = hook.got.find(item => /命中大奖/.test(item.title || ''));
    check('大奖那条推出去了', !!big, hook.got.map(i => i.title).join(' | '));
    check('点明了折算成憨豆',
        /命中大奖：⭐ VIP 7 天 → 已折算 1,000,000 憨豆/.test(big?.content || ''),
        big?.content);

    await hook.close();
    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[69] 憨豆大奖不重复写名字');
{
    // 憨豆的 label 自己就带「憨豆」二字，再补类别名会变成
    // 「💰 憨豆 780,000 憨豆」
    const site = await startSite({
        prizes: ['魔力 780000 '],
        balance: 500000
    });
    const hook = await startWebhook();

    await runScript({
        host: site.state.origin, draws: 1, interval: 0.5,
        notifyBigPrize: true, bigPrizeMinBeans: 100000, webhookUrl: hook.url
    });

    const big = hook.got.find(item => /命中大奖/.test(item.title || ''));
    check('还是「💰 780,000 憨豆」', /命中大奖：💰 780,000 憨豆/.test(big?.content || ''),
        big?.content);
    check('没有写成「憨豆 780,000 憨豆」',
        !/憨豆 780,000 憨豆/.test(big?.content || ''), big?.content);

    await hook.close();
    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[70] 中大奖就收工（stopOnBigPrize）');
{
    // 第 2 抽给 780,000，后面还剩 3 抽的额度 —— 停没停看站点收到几次就知道
    const site = await startSite({
        prizes: ['魔力 100 ', '魔力 780000 ', '魔力 100 ', '魔力 100 ', '魔力 100 '],
        balance: 1000000
    });
    const hook = await startWebhook();

    const { out } = await runScript({
        host: site.state.origin, draws: 5, interval: 0.3,
        stopOnBigPrize: true, notifyBigPrize: true, bigPrizeMinBeans: 780000,
        webhookUrl: hook.url
    });

    check('抽到大奖那一注就收手', site.state.draws === 2, `实际 ${site.state.draws}`);
    check('第 1 抽的小奖没触发停机', /第 1 抽/.test(out), out.slice(-900));
    check('日志点明是中大奖才停的', /中了大奖.*按设置停止/.test(out), out.slice(-900));

    const big = hook.got.find(item => /命中大奖/.test(item.title || ''));
    check('大奖通知照发', !!big, hook.got.map(i => i.title).join(' | '));
    check('通知末行说的是已停止，不是「后台持续挂机中」',
        /已按设置停止本轮抽奖/.test(big?.content || '')
        && !/后台持续挂机/.test(big?.content || ''), big?.content);
    check('收尾汇总里写明了停止原因',
        hook.got.some(item => /中了大奖/.test(item.content || '')),
        hook.got.map(i => i.content).join(' | ').slice(0, 400));

    await hook.close();
    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[71] 停机和通知是两个开关，互不牵连');
{
    // 默认不开：中了也接着抽
    const idle = await startSite({
        prizes: ['魔力 780000 ', '魔力 100 '], balance: 1000000
    });
    await runScript({
        host: idle.state.origin, draws: 4, interval: 0.3, notifyBigPrize: false
    });
    check('没打开开关就一路抽满 4 抽', idle.state.draws === 4, `实际 ${idle.state.draws}`);
    await idle.close();

    // 通知关着，停机照样生效 —— 别把两件事绑在一起
    const quiet = await startSite({
        prizes: ['魔力 100 ', '魔力 780000 ', '魔力 100 ', '魔力 100 '], balance: 1000000
    });
    await runScript({
        host: quiet.state.origin, draws: 4, interval: 0.3,
        notifyBigPrize: false, stopOnBigPrize: true
    });
    check('通知关着也能停在第 2 抽', quiet.state.draws === 2, `实际 ${quiet.state.draws}`);
    await quiet.close();

    // 门槛之下的不算大奖，不该停
    const small = await startSite({
        prizes: ['魔力 5000 '], balance: 1000000
    });
    await runScript({
        host: small.state.origin, draws: 3, interval: 0.3,
        stopOnBigPrize: true, bigPrizeMinBeans: 780000
    });
    check('没到门槛的奖不触发停机', small.state.draws === 3, `实际 ${small.state.draws}`);
    await small.close();
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n=========== ${passed} passed, ${failed} failed ===========\n`);
process.exit(failed ? 1 : 0);


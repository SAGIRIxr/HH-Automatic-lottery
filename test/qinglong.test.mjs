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

/* 等级是按图标文件名判的 —— 站点能把等级名字改得面目全非，图标名不变 */
const userDetailsPage = klass => `<html><body>
    <table><tr><td class="rowhead">等级：</td>
    <td class="rowfollow"><img class="rank" src="pic/${klass}.gif" alt="${klass}"></td></tr></table>
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
 */
function startSite({ prizes = ['魔力 100 '], balance = 100000, cost = 2000, onDraw = null,
                     mail = [], pageSize = 100, loggedOut = false,
                     swapBeans = 0, userClass = null, classFailTimes = 0 } = {}) {
    const state = {
        balance, cost, draws: 0, deleted: [], mailPageHits: [],
        mail: [...mail], drawn: [], classFails: 0
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
            const text = prizes[state.draws % prizes.length];
            state.draws++;
            state.drawn.push(text);
            state.balance -= state.cost;
            if (/魔力|憨豆/.test(text)) {
                const won = Number(String(text).match(/(\d[\d,]*)/)?.[1].replace(/,/g, '')) || 0;
                state.balance += won;
            }
            onDraw?.(state, text);
            return send(200, JSON.stringify({ ret: 0, data: { prize_text: text, winning_record_id: 900 + state.draws } }),
                'application/json');
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
    statsFile: '',
    draws: 10,
    reserve: 0,
    interval: 3,
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

function runFile(file, dir) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [file], { cwd: ROOT });
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
    check('汇总块不套时间戳，免得没法看',
        (after || '').split('\n').filter(l => l.trim()).every(line => !/^\[\d\d\/\d\d/.test(line)),
        (after || '').slice(0, 200));

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
console.log('\n[23] 等级说是 VIP 就是 VIP，不用等余额对上');
{
    // 余额一点没变（读数滞后 / 别的标签页同时在花），
    // 按等级判照样能定，不再依赖余额差
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        swapBeans: 1000000,
        userClass: 'uploader'      // 比 VIP 还高的等级，也该算
    });
    const statsFile = path.join(TMP, 'stats-class.json');

    const { out } = await runScript({ host: site.state.origin, draws: 1, statsFile });
    const t = JSON.parse(fs.readFileSync(statsFile, 'utf8')).total;

    check('余额没变也认定为折算', /站点改发了 1,000,000 憨豆/.test(out), out.slice(-700));
    check('VIP 以上的等级同样算', t.prizes.vip.swappedBeans === 1000000,
        JSON.stringify(t.prizes.vip));
    check('查等级只查一次，不是每抽都查',
        (site.state.classPageHits || 0) === 1, `实际 ${site.state.classPageHits} 次`);

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
    check('明说读不到等级、无法确认',
        /读不到你的等级，无法确认是否折算/.test(out), out.slice(-700));

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
    // 第一次查等级 502，第二次通。两注都不带余额变化 ——
    // 所以只有「真查到等级」才可能折算，正好分得出重试有没有生效。
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        swapBeans: 1000000,
        userClass: 'vip',
        classFailTimes: 1
    });
    const statsFile = path.join(TMP, 'stats-retry.json');

    await runScript({ host: site.state.origin, draws: 2, statsFile });
    const t = JSON.parse(fs.readFileSync(statsFile, 'utf8')).total;

    check('两注都算 VIP 中奖', t.prizes.vip.count === 2, `实际 ${t.prizes.vip.count}`);
    check('第一注查不到等级、余额也对不上，老实记 7 天',
        t.prizes.vip.tiers['7 天'] === 1, JSON.stringify(t.prizes.vip.tiers));
    check('第二注重试查到了等级，按折算记',
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
        userClass: 'vip'
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

/* ---------------------------------------------------------------- */
console.log('\n[36] 命中大奖（邀请 / VIP / 78w 憨豆）立即触发通知');
{
    const site = await startSite({
        prizes: ['邀请 1 个', '魔力 780000 ', 'VIP 7 Day(s)'],
        balance: 1000000
    });

    const notifyLog = path.join(TMP, 'notify-big-prizes.log');
    const mockSendNotify = `const fs = require('fs');
module.exports = {
    sendNotify: async (title, content) => {
        fs.appendFileSync(${JSON.stringify(notifyLog)}, title + '\\n' + content + '\\n---END---\\n');
    }
};`;

    const { dir, file } = installScript(
        { host: site.state.origin, draws: 3, notifyBigPrize: true, bigPrizeMinBeans: 780000 },
        null,
        { 'sendNotify.js': mockSendNotify }
    );

    const { code, out } = await runFile(file, dir);

    check('正常退出', code === 0, `exit ${code}`);
    check('日志报了 3 次大奖命中', (out.match(/命中大奖/g) || []).length === 3, out.slice(-800));

    const notifyContent = fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8') : '';
    check('邀请大奖推了通知', /命中大奖：📧 邀请码 1 个/.test(notifyContent));
    check('78w 憨豆大奖推了通知', /命中大奖：💰 780,000 憨豆/.test(notifyContent));
    check('VIP 大奖推了通知', /命中大奖：⭐ VIP 7 天/.test(notifyContent));
    check('通知带了卡片分隔线和运行战报', /━━━━━━━━━━━━━━━━━━━/.test(notifyContent));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[37] 运行总报与排版美化');
{
    const site = await startSite({
        prizes: ['魔力 5000 '],
        balance: 100000
    });

    const notifyLog = path.join(TMP, 'notify-summary.log');
    const mockSendNotify = `const fs = require('fs');
module.exports = {
    sendNotify: async (title, content) => {
        fs.appendFileSync(${JSON.stringify(notifyLog)}, title + '\\n' + content + '\\n---END---\\n');
    }
};`;

    const { dir, file } = installScript(
        { host: site.state.origin, draws: 2 },
        null,
        { 'sendNotify.js': mockSendNotify }
    );

    await runFile(file, dir);
    const notifyContent = fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8') : '';

    check('总报标题包含运行总报', /【HHCLUB 幸运大转盘】运行总报/.test(notifyContent));
    check('排版包含美化卡片内容', /运行时长：/.test(notifyContent) && /最终余额：/.test(notifyContent));

    await site.close();
}

/* ---------------------------------------------------------------- */
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n=========== ${passed} passed, ${failed} failed ===========\n`);
process.exit(failed ? 1 : 0);


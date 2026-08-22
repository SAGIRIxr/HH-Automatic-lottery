# HHCLUB 幸运大转盘 · 命令行版

**不只能在青龙里跑** —— 任何装了 Node 18+ 的机器（Debian / Ubuntu / NAS / 群晖…）`node hh_lottery.js` 直接就能用。不用开浏览器、不用挂机。**所有配置都在脚本最上面那一块，改完保存就能跑，不用配环境变量。** 跟油猴版共用一套抽奖逻辑（限流退避、VIP 折算、站内信清理都在），只是把面板换成了日志和通知。

统计会存成一份 JSON，**格式和油猴版的「💾 备份 JSON」完全一致** —— 挂 NAS 上跑，隔段时间把文件拿下来，在浏览器面板里点「📥 导入备份」就能合进电脑上的历史统计。

**依赖：Node 18 以上。** 用的是内置 `fetch`，不需要 `npm install` 任何东西。

---

## 装

#> **断网不会当场收摊**：机器网络抖一下（DNS 挂了、连接被重置）不再一次失败就退出，
> 而是退避重试，10 次约能扛住 8 分钟；网络回来自动接着抽。

## 青龙

脚本管理 → 新建 `hh_lottery.js`，把 [`hh_lottery.js`](hh_lottery.js) 全文贴进去。或者直接拉：

```bash
ql raw https://raw.githubusercontent.com/SAGIRIxr/HH-Automatic-lottery/main/qinglong/hh_lottery.js
```

脚本头部带了 `cron: 5 9 * * *`（每天早上 9:05），青龙一般会自动识别；没识别就手动建个定时任务指过去。

### Debian / Ubuntu / NAS 直接跑

只要 Node 18 以上，下下来改完配置就能跑，没有任何依赖：

```bash
curl -fLO https://raw.githubusercontent.com/SAGIRIxr/HH-Automatic-lottery/main/qinglong/hh_lottery.js
```

```bash
node hh_lottery.js
```

Debian 12 自带的 `nodejs` 包是 18.19，够用；`node -v` 看一下就知道。

定时用 crontab（`crontab -e`）：

```
5 9 * * * cd /opt/hh && /usr/bin/node hh_lottery.js >> /var/log/hh-lottery.log 2>&1
```

或者 systemd timer，`/etc/systemd/system/hh-lottery.service`：

```ini
[Unit]
Description=HHCLUB 幸运大转盘

[Service]
Type=oneshot
WorkingDirectory=/opt/hh
ExecStart=/usr/bin/node /opt/hh/hh_lottery.js
```

`/etc/systemd/system/hh-lottery.timer`：

```ini
[Unit]
Description=每天跑一次 HHCLUB 抽奖

[Timer]
OnCalendar=*-*-* 09:05:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now hh-lottery.timer
```

跑到一半按 Ctrl-C（或者 `systemctl stop`）不会丢成绩，细节见下面「中途打断会怎样」。

---

## 配置

两种放法，**推荐外置**：

### 外置（推荐，更新脚本不会被冲掉）

**已经在用、设置写在脚本里的老用户：** 什么都不用做，跑一次就行 —— 脚本会把你**当前生效的设置**（含 Cookie）原样存成 `hh_lottery.config.json`，日志里会说一声。之后再 `ql raw` / `curl` 覆盖脚本，设置都在。已有配置文件的话绝不会被覆盖。

第一次直接跑一下，脚本会在同目录生成 `hh_lottery.config.json`：

```bash
node hh_lottery.js
```

把里面的 `cookie` 换成你的，再跑一次就行。以后更新只要覆盖 `hh_lottery.js`，配置文件原样保留：

```bash
curl -fLO https://raw.githubusercontent.com/SAGIRIxr/HH-Automatic-lottery/main/qinglong/hh_lottery.js
```

配置文件里只写你要改的项也行，没写的按脚本里的默认值走。`"//"` 开头的项当注释忽略，认不出的项会在日志里点名。

脚本以后新加的开关，会在下次运行时自动补进你已有的配置文件里（值取当前版本默认值），日志里会说补了哪些 —— 不然照着老文件填的人根本不知道有这些项。你自己填的值、自己加的项都不动。本次升级会补上并默认开启 `followDuration`；若仍想用旧的固定间隔，把它改成 `false`。

### 写在脚本里

不想多一个文件的话，直接改脚本最上面那块也行（有外置配置时以外置的为准）：

```js
const CONFIG = {
    /* ① Cookie（必填） */
    cookie: '在这里粘贴你的 Cookie',

    draws: 10,          // ② 每次抽多少次。填 0 = 一抽到底
    reserve: 0,         // ③ 一抽到底时留多少憨豆
    interval: 6.8,      // ④ 固定间隔；关闭自适应后才生效，最小 3 秒
    followDuration: true,       // ⑤ 按上一抽的转盘时长自适应延迟（推荐）
    durationBufferMs: 0,        // ⑥ 自适应缓冲，-500 ~ 5000ms
    maxMinutes: 60,     // ⑦ 单次运行时间上限（分钟）
    cleanMail: false,   // ⑧ 抽完顺手清抽奖站内信
    statsFile: 'hh_lottery_stats.json',   // ⑨ 统计存哪儿，留空 '' 就是不记

    notifyBigPrize: true,      // ⑩ 中了大奖当场推一条
    bigPrizeMinBeans: 780000,  // ⑪ 多少憨豆算大奖，填 0 就只有 VIP 才推
    notifyPeriodic: false,     // ⑫ 定时播报战报，默认关
    periodicMinutes: 30,       // ⑬ 定时战报推送间隔（分钟），0 = 关闭

    tgBotToken: '',            // ⑭ Telegram 直推，青龙里配过 TG 就别填
    tgUserId: '',
    tgApiHost: 'api.telegram.org',
    webhookUrl: '',            // ⑮ 通用 Webhook，留空不用

    timezone: 'Asia/Shanghai', // ⑯ 日志时间按哪个时区显示
    host: 'hhanclub.net',      // ⑰
    userAgent: '...'           // ⑱
};
```

| 项 | 默认 | 说明 |
|---|---|---|
| `cookie` | **必填** | 站点完整 Cookie |
| `draws` | `10` | 每次运行抽多少次。**填 `0` 表示一抽到底** |
| `reserve` | `0` | 一抽到底时留多少憨豆不动 |
| `interval` | `6.8` | 固定间隔（秒），最小 3；仅在 `followDuration: false` 时生效 |
| `followDuration` | `true` | 自适应延迟。按上一抽返回的 `data.duration` 安排下一抽，开启后 `interval` 完全不参与节奏 |
| `durationBufferMs` | `0` | 自适应延迟缓冲，范围 -500～5000ms。负值更贴边，正值更保守 |
| `maxMinutes` | `60` | 单次运行时间上限（分钟），防止一抽到底把任务挂死 |
| `cleanMail` | `false` | 清掉「幸运大转盘 中奖通知」站内信：抽奖途中每 25 抽一次，收尾再翻一遍整个收件箱 |
| `statsFile` | `hh_lottery_stats.json` | 统计存到哪个文件，相对路径按脚本所在目录算。留空 `''` 就是不记 |
| `notifyBigPrize` | `true` | 中了大奖（VIP，或单笔憨豆到下面的门槛）当场推一条，不用等跑完 |
| `bigPrizeMinBeans` | `780000` | 多少憨豆算大奖。填 `0` 就只有 VIP 才推 |
| `notifyPeriodic` | `false` | 定时推送战报。**默认关着** —— 跑一轮推一条收尾通知已经够用，挂机长跑想中途也收到播报再改成 `true` |
| `periodicMinutes` | `30` | 定时战报推送间隔（分钟）。填 `0` 为关闭定时播报。别填得比 `maxMinutes` 还大 —— 一轮跑完都没到播报点，等于白开，脚本启动时会提醒你 |
| `tgBotToken` / `tgUserId` | 空 | Telegram 直推。**青龙里已经配过 TG 推送的话别填**，青龙的 `sendNotify` 会推一条，这里再推就是重复。只认填在这儿的值，不读青龙的环境变量 |
| `tgApiHost` | `api.telegram.org` | TG API 域名，走反代才需要改 |
| `webhookUrl` | 空 | 通用 Webhook，POST 一份 JSON。Bark / 自建 / n8n 都能接 |
| `timezone` | `Asia/Shanghai` | 日志时间按哪个时区显示。容器里系统时区多半是 UTC，不设的话日志时间跟你对不上 |
| `host` | `hhanclub.net` | 站点域名，一般不用改 |
| `userAgent` | Chrome | 一般不用改 |

填错类型不会炸：数字项会收敛到合法范围，`cookie` 没换掉的话会直接提示你去填而不是拿占位文字去请求；配置文件不是合法 JSON 会说明一句然后退回脚本里的配置。

### 几种常见配法

```js
draws: 20,                          // 每天固定抽 20 次
```

```js
draws: 0, reserve: 500000, maxMinutes: 120,   // 抽到只剩 50 万，最多跑 2 小时
```

```js
cleanMail: true,                    // 顺手清站内信
```

---

## 取 Cookie

浏览器登录 hhanclub.net → F12 → Network → 随便点一个请求 → 请求头里的 `Cookie:` 整行复制。

大概长这样（`c_secure_uid` 和 `c_secure_pass` 是关键，少了就登不上）：

```
c_secure_uid=NzMyMQ%3D%3D; c_secure_pass=...; c_secure_ssl=...; c_secure_tracker_ssl=...; c_secure_login=...
```

**Cookie 等于你的账号。** 别往任何第三方脚本或聊天框里贴。

（站点每人只能有一个号，所以这里没做多账号。）

---

## 跑完能看到什么

```
[08/19 09:05:01] 🎡 HHCLUB 幸运大转盘
[08/19 09:05:01]    抽 20 次 · 自适应延迟 · 缓冲 0ms
[08/19 09:05:02] ▶ 开始 · 余额 1,574,093 憨豆 · 单抽 2,000
[08/19 09:05:02] 🎲 第 1 抽：魔力 2000 · 余额 1,574,093
[08/19 09:05:10] 🎲 第 2 抽：补签卡 1 · 余额 1,572,093
...
[08/19 09:07:48] 📪 清掉 20 封抽奖通知
[08/19 09:07:48] 💾 统计已存到 /opt/hh/hh_lottery_stats.json

────────────────────────────────────────
本次：10 抽
  消耗 20,000 · 获得 7,300 憨豆
  盈亏 -12,700（-63.5%）
  💰 憨豆 6 次 · 7,300
      100 憨豆 × 3
      1,000 憨豆 × 2
      5,000 憨豆 × 1
  🎫 补签卡 2 次 · 2 个
      1 个 × 2
  🌈 彩虹ID 1 次 · 7 天
      7 天 × 1
  ⬆️ 上传量 1 次 · 2 GB
      2 GB × 1

历史总计：20 抽
  消耗 40,000 · 获得 13,900 憨豆
  盈亏 -26,100（-65.3%）
  💰 憨豆 15 次 · 13,900
      100 憨豆 × 9
      2,000 憨豆 × 3
      1,000 憨豆 × 2
      5,000 憨豆 × 1
  🌈 彩虹ID 2 次 · 14 天
      7 天 × 2
  🎫 补签卡 2 次 · 2 个
      1 个 × 2
  ⬆️ 上传量 1 次 · 2 GB
      2 GB × 1

余额 1,256,247.2
```

每行日志都带时间戳（按 `timezone` 显示），汇总块不带 —— 套上反而没法看。青龙装了通知模块的话，这份汇总会一并推过去；直接跑的话重定向到文件即可。

---

## 中途打断会怎样

按 Ctrl-C、`systemctl stop`、青龙里点停止（都是 SIGINT / SIGTERM）：

- **已经抽到的成绩会存下来** —— 收到信号先写统计文件再退出，汇总也照样打
- **不会触发站内信清理** —— 直接退出，这一轮的通知留到下次跑再清
- 正在飞的那一次抽奖请求可能已经在服务端扣了豆但没记上，最多差一抽

`kill -9` 或者断电就没这个待遇了，不过统计文件是**先写临时文件再改名**的原子替换，最坏情况是丢掉这一轮，不会把之前攒的几千抽写成半截 JSON 读不出来。

正常跑完的顺序也是**先落盘再清信** —— 清信可能要上百个请求，卡在那儿被 kill 的话成绩不能跟着丢。

---

## 统计导出 / 导入电脑

`statsFile` 指的那份 JSON 就是油猴版的备份格式，跨次运行一直累加：

```json
{
  "kind": "hhclub-lottery-backup",
  "version": 4,
  "exportedAt": "2026-08-19T12:00:00.000Z",
  "source": "qinglong",
  "current": { "draws": 20, ... },   // 这一次跑的
  "total":   { "draws": 860, ... }   // 累计
}
```

默认落在脚本同目录（青龙里一般是 `/ql/data/scripts/hh_lottery_stats.json`），写绝对路径也行。

**导到电脑上：** 把这个文件下载下来 → 打开 `hhanclub.net/lucky.php` → 面板上点「📥 导入备份」→ 选**合并**。两边记录本来就不重合，合并之后 NAS 上抽的和电脑上抽的就并到一块了。

导入读的是 `total` 那一份，所以每次导的都是完整累计；要是你在电脑上也抽过，选「合并」会把两边相加 —— 别重复导同一个文件，不然会算两遍。

---

## 它会自己处理的几件事

- **通知** —— 青龙里优先用它自己 preload 的 `/ql/shell/preload/__ql_notify__.js`，其次是各处的 `sendNotify.js`，再不行退到全局 `QLAPI.systemNotify`。`/ql/data/scripts` 下常躺着别的脚本留下的 `sendNotify.js`（依赖没装、`require` 直接抛），所以顺序不能反。青龙的 `sendNotify` 只是「调用了」，它一个渠道都没配时也不会报错、也不返回状态，所以脚本不拿它当送达凭据；你自己填在配置里的 Telegram / Webhook 一律照发。日志里逐个渠道报结果
- **自适应延迟** —— 站点的冷却就是上一抽返回的转盘时长 `data.duration`，脚本从请求发出时开始计时，响应与本地处理耗时也算在冷却内。自适应开启时手填的 `interval` 完全不参与；还没拿到首个 duration 时先按 5 秒兜底
- **限流补枪 / 退避** —— 自适应模式下，已知冷却时被拦会在 300ms 后补枪，尚无 duration 时按 1 秒起步。连续被拦就每 3 次抬一档（×1.5），一路到 5 分钟封顶 —— **不再有「放弃」这回事**：站点限流总会过去，收摊反而白白空过一整夜。接口报错按 1 秒起步、网络不通按 10 秒起步，同样是抬档不放弃
- **接口异常** —— 连续 5 次失败自动停，不会闷头刷请求
- **憨豆不足 / 次数用完** —— 站点这么说就立刻停，不重试
- **单抽消耗变了** —— 每次开跑前读页面上的实际值，站点调价自动跟上
- **站内信** —— 开了 `cleanMail` 的话，抽奖途中每 25 抽扫一次第一页（和油猴版一个节奏），收尾再翻一遍整个收件箱。途中那遍够不着被「种子被删除」压在下面的旧通知，靠收尾这遍捞。只删主题带「幸运大转盘」的
- **已是 VIP 时的憨豆折算** —— 见下

### 关于 VIP

抽奖页写着：**「当中奖 [VIP] 时，如果用户已经是 VIP 或以上等级，奖励憨豆：1000000」**，但接口返回的中奖文案还是 `VIP 7 Day(s)`。照文案记账的话，这一注会被记成「VIP 7 天」，一百万憨豆凭空蒸发。

**怎么判断该不该折算：按等级。** 「VIP 或以上等级」说的是 NexusPHP 的 class，是确定的事实。站点能把等级名字改得面目全非（本站叫「俺不中类」），但等级图标还是标准文件名（`pic/vip.gif`、`pic/uploader.gif` 等），所以按图标查 class 排名。判出来之后，别人赠送魔力、做种收益、余额读数滞后统统影响不到。查一次就记住。

读不到等级时才退回余额差，而且要求落在公布金额附近 ±20,000 的窄带里 —— 松了的话抽奖期间收到一笔赠送就能骗过去。偏差过大时明说读不到等级、无法确认，按 VIP 记，不瞎猜。**查失败（网络抖一下、502）只是这一次失败**，下次再中 VIP 还会重新查，不会一整轮都退回猜。

**折算多少憨豆：按站点公布值。** 就是抽奖页上那句话里的 1000000，不能拿余额差当金额 —— 憨豆会因为做种持续增长，两次读数之间涨的那几十点会被当成中奖收入，记出「1,000,060 憨豆」这种奖池里根本没有的档位。对不上的部分单独记一行说明是做种收益。

**认定之后这一注仍然算一次 VIP 中奖**（转盘确实停在 VIP 那一格，爆率统计不该少这一笔），变的只是档位和收益：

- VIP 档位从「7 天」换成「已转换为憨豆 1,000,000」
- VIP 天数扣回去（没真拿到）
- 憨豆收入加上，单独记在 `swappedBeans` 上 —— 天数和憨豆不是一个单位，不能混在一起

折算来的憨豆不在憨豆档位里，所以汇总的「获得 X 憨豆」后面会注明有多少来自折算 —— 不然拿各档位乘开去对总数会差出一百万，看着像 bug。

这套口径和油猴版 v1.18.0 完全一致。

---

## 测试

```bash
npm run test:ql
```

会在本地起一个假站点，把脚本当子进程真跑一遍，覆盖按次数抽 / 一抽到底 / 自适应 duration 节奏与缓冲 / 已知和未知冷却的限流补枪 / VIP 折算两种走向及其跨次留存 / 站内信清理（含每页 10 封的分页）/ 统计导出格式 / 跨次累计 / 统计文件损坏 / Cookie 没填 / Cookie 失效 / 日志时间戳与时区 / 汇总的分类分组 / 按等级判折算的四种走向 / 清信的节奏与全本扫描 / 外置配置与模板生成 / 中途打断 / 等级查失败后的重试 / 通知渠道兜底 / 大奖即时推送 / 青龙信号接管 / 间隔精度 / 老用户升级不丢设置 / 在仓库里直接运行 / 老配置文件补新项。

测试是**照你的用法来的**：复制一份源码、把配置区整块换掉、再当子进程真跑，所以配置区的写法本身也在被测。

抽奖接口是花真憨豆的，没法拿线上验证，所以这层是它唯一的安全网 —— 改完记得跑。

---

## 免责声明

脚本只调用站点自身的接口，不做任何数据篡改。请自行控制抽奖频率，因使用本脚本产生的任何后果由使用者自行承担。

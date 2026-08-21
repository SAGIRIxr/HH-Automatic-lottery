# 🎰 HHCLUB 幸运大转盘 · 青龙与后台挂机增强版

**专为青龙面板与服务器后台常驻优化** —— 支持**后台持续挂机抽奖**、**命中大奖即时推送**（邀请 / VIP / 78w+ 憨豆）、**周期统计战报**（每小时 / 自定义频率）以及**卡片式美化排版**。

任何安装了 Node.js 18+ 的环境（青龙面板 / 群晖 / NAS / Linux 服务器）均可直接运行。

统计数据会自动落盘为标准 JSON 文件，**格式与油猴脚本备份完全兼容**，随时可导入导出。

> 💡 **原生运行**：Node.js 18+ 原生内置 `fetch`，**无需 `npm install` 任何第三方依赖**。

---

## 🌟 核心特性

1. 🔄 **后台持续挂机（Continuous 模式）**
   - 设为后台持续挂机模式后，脚本长效常驻后台；
   - 憨豆不足或跌破保留线时自动休眠（默认 10 分钟），周期性检查做种收益，一旦有豆自动继续抽奖。
2. 🎉 **大奖即时推送通知**
   - 抽中 **💌 邀请码**、**⭐ VIP（或 VIP 折算 100W 憨豆）**、**💰 78w+ 憨豆** 等大奖时，第一时间触发推送通知！
3. 📊 **定时周期统计战报**
   - 支持设置每隔 1 小时（或自定义分钟）推送一次时段战报，同时展示「时段增量」与「历史累计总量」。
4. 🛡️ **优雅退出与 100% 数据/通知保障**
   - 接管青龙退出信号，手动停止时**数据安全存盘并确保通知 100% 成功送达**后优雅退出。
5. 📱 **通知卡片精美排版**
   - 完美适配 Bark、企业微信、Telegram、PushPlus、钉钉、Server酱 等全渠道推送。
   - 优先使用青龙 `sendNotify`，若未配置或失败自动尝试 Telegram 直连兜底，绝不重复推送。

---

## 🚀 青龙面板快速上手

### 步骤 1：添加脚本任务
青龙面板 → **定时任务** → **新建任务**：
* **名称**：`HHCLUB幸运大转盘`
* **命令**：`ql raw https://raw.githubusercontent.com/Agonie0v0/HH-Automatic-lottery/main/qinglong/hh_lottery.js`
* **定时规则**：`5 9 * * *`（每天早上 9:05 自动执行）

### 步骤 2：配置环境变量
青龙面板 → **环境变量**，添加以下常用变量：

| 环境变量名 | 示例值 | 说明 |
| :--- | :--- | :--- |
| `HH_COOKIE` | `c_secure_uid=...; c_secure_pass=...` | **（必填）** 你的站点 Cookie |
| `HH_CONTINUOUS` | `true` | 是否开启后台持续挂机抽奖（`true` 或 `false`） |
| `HH_DRAWS` | `0` | 抽奖次数（`0` 表示一抽到底） |
| `HH_RESERVE` | `0` | 保留憨豆底线（低于此数值暂停抽奖） |
| `HH_INTERVAL` | `8` | 每抽间隔（秒，建议保持 8 秒防风控） |
| `HH_NOTIFY_BIG_PRIZE` | `true` | 抽中自定义大奖时是否即时推送通知 |
| `HH_BIG_PRIZE_TYPES` | `invite,vip,beans,rainbow` | 自定义哪些奖品属于大奖（支持 `invite,vip,beans,rainbow,upload,makeup,rename,all`，也支持中文别名） |
| `HH_BIG_PRIZE_MIN` | `780000` | 触发大奖推送的憨豆数门槛（默认 78w，当包含憨豆奖项时生效） |
| `HH_BIG_PRIZE_MIN_UPLOAD` | `0` | 触发大奖推送的上传量门槛（GB，默认 0 表示任意上传量都推） |
| `HH_BIG_PRIZE_KEYWORDS` | `特等,专属` | 自定义大奖关键词（只要中奖文案包含此关键词立即推送通知） |
| `HH_REPORT_INTERVAL` | `60` | 定期推送运行简报间隔（分钟，`60` = 1小时） |
| `HH_CLEAN_MAIL` | `true` | 是否自动清理抽奖产生的系统站内信 |

---

## ⚙️ 配置文件说明

支持三种配置方式，加载优先级为：
**`hh_lottery.config.json`（外置文件） > 青龙环境变量（`HH_*`） > 脚本内部 `CONFIG`**

### 外置配置文件 `hh_lottery.config.json`
更新脚本时不会覆盖你的个人配置。首次运行会自动生成模板：

```json
{
    "//": "配置放置于此，更新脚本时不会被覆盖。各项含义见下表",
    "cookie": "在这里粘贴你的完整 Cookie",
    "draws": 0,
    "continuous": true,
    "reserve": 0,
    "interval": 8,
    "maxMinutes": 0,
    "sleepOnLowMinutes": 10,
    "notifyBigPrize": true,
    "bigPrizeTypes": ["invite", "vip", "beans"],
    "bigPrizeMinBeans": 780000,
    "bigPrizeMinUpload": 0,
    "bigPrizeMinRainbow": 0,
    "bigPrizeKeywords": "",
    "reportIntervalMinutes": 60,
    "cleanMail": true,
    "statsFile": "hh_lottery_stats.json",
    "timezone": "Asia/Shanghai",
    "host": "hhanclub.net"
}
```

### 配置项详细说明

| 项 | 默认值 | 对应环境变量 | 说明 |
|---|---|---|---|
| `cookie` | 空 | `HH_COOKIE` | **必填**，站点完整 Cookie |
| `continuous` | `false` | `HH_CONTINUOUS` | **后台持续挂机模式**。设为 `true` 时余额不足会自动休眠，后台一直常驻运行 |
| `draws` | `10` | `HH_DRAWS` | 每次运行抽多少次。**填 `0` 表示一抽到底** |
| `reserve` | `0` | `HH_RESERVE` | 保留多少憨豆不动（防手滑抽光） |
| `interval` | `8` | `HH_INTERVAL` | 每抽间隔（秒，建议不低于 5 秒防风控） |
| `maxMinutes` | `60` | `HH_MAX_MINUTES` | 单次运行时间上限（分钟）。**持续挂机建议设为 `0`（不限时长）** |
| `sleepOnLowMinutes` | `10` | `HH_SLEEP_ON_LOW` | 持续模式下，余额不足时的休眠检查间隔（分钟） |
| `notifyBigPrize` | `true` | `HH_NOTIFY_BIG_PRIZE`| 命中自定义大奖时立即推送通知 |
| `bigPrizeTypes` | `["invite","vip","beans"]` | `HH_BIG_PRIZE_TYPES` | 自定义大奖类型（可选 `invite,vip,beans,rainbow,upload,makeup,rename,all`） |
| `bigPrizeMinBeans` | `780000` | `HH_BIG_PRIZE_MIN` | 触发大奖推送的憨豆数门槛（默认 780,000 即 78w） |
| `bigPrizeMinUpload` | `0` | `HH_BIG_PRIZE_MIN_UPLOAD` | 触发大奖推送的上传量门槛（GB，默认 0 表示任意上传量都推） |
| `bigPrizeMinRainbow` | `0` | `HH_BIG_PRIZE_MIN_RAINBOW` | 触发大奖推送的彩虹ID天数门槛（天，默认 0 表示任意天数都推） |
| `bigPrizeKeywords` | `""` | `HH_BIG_PRIZE_KEYWORDS` | 自定义大奖关键词（多个用逗号隔开，匹配文案即推大奖通知） |
| `reportIntervalMinutes`| `60` | `HH_REPORT_INTERVAL` | 运行中每隔多少分钟推送一次统计简报（`0` 表示不发送周期简报） |
| `cleanMail` | `false` | `HH_CLEAN_MAIL` | 抽完顺手清理「幸运大转盘 中奖通知」站内信，不误删重要邮件 |
| `statsFile` | `hh_lottery_stats.json` | `HH_STATS_FILE` | 统计存到哪个文件，留空 `""` 表示不存文件 |
| `timezone` | `Asia/Shanghai` | `HH_TIMEZONE` | 日志和通知时间的时区 |

---

## 🎯 推荐场景配置

### 场景 1：青龙后台 24 小时常驻自动抽（一有豆子就抽）
* `continuous`: `true`
* `draws`: `0`
* `maxMinutes`: `0`
* `reportIntervalMinutes`: `60`（每小时播报一次）
* `cleanMail`: `true`

### 场景 2：每天定时定量抽（如每天抽 50 次）
* `continuous`: `false`
* `draws`: `50`
* `cleanMail`: `true`
* 青龙 Cron 定时：`5 9 * * *`（每天早上 9:05）

---

## 🧪 自动化测试

项目内置完整的 Mock 测试套件：

```bash
npm test
```

覆盖 41 个专项测试场景，共 168 项断言全部通过。

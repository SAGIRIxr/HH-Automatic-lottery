# 🎰 HHCLUB 幸运大转盘 · 全自动挂机与通知助手

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18+-68a063?style=flat-square&logo=node.js" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/QingLong-青龙面板支持-007acc?style=flat-square" alt="QingLong">
  <img src="https://img.shields.io/badge/Dependencies-0%20Dependencies-brightgreen?style=flat-square" alt="0 Dependencies">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="License">
</p>

专为 PT 站点 **HHCLUB（憨憨 / hhanclub.net）**「幸运大转盘」打造的全自动化抽奖与挂机监控工具。

适用于 **青龙面板（Qinglong）**、**群晖 / NAS** 以及 **Linux / Windows 服务器命令行**。支持 24 小时后台常驻挂机、做种自动休眠复苏、大奖即时推送、小时级战报简报、数据备份与合并导入，以及智能站内信清理。

> 💡 **原生轻量**：基于 Node.js 18+ 内置原生 `fetch` 开发，**无需 `npm install` 安装任何第三方依赖包**，即下即跑。

---

## 🌟 核心特性

- 🔄 **24 小时后台挂机（Continuous 模式）**
  - 当憨豆不足或低于保留底线时，自动进入智能休眠（默认 10 分钟）；
  - 周期性检测做种收益，一旦回血自动复苏继续抽奖，无需人工值守。
- 🎉 **命中大奖即时推送**
  - 抽中 **💌 邀请码**、**⭐ VIP（或 VIP 折算 100W 憨豆）**、**💰 78w+ 憨豆** 等大奖时，第一时间触发全渠道消息推送。
- 📊 **定时周期统计战报**
  - 支持每隔 1 小时（或自定义分钟）推送运行战报，卡片式展示「此次播报增量」与「历史累计总量」。
- 🛡️ **优雅退出与 100% 通知送达**
  - 主动接管青龙 `SIGTERM`/`SIGINT` 中断信号；
  - 手动停止或任务结束时，**数据瞬间原子落盘并确保推送通知 100% 成功送达**，绝不漏报。
- 👑 **智能 VIP 等级折算识别**
  - 自动识别 VIP 或更高等级用户的换发规则（站点改发 1,000,000 憨豆）；
  - 自动按等级图标判定并修正统计，避免百万憨豆收益被漏记。
- 💾 **历史记录安全落盘与合并导入**
  - 每次抽奖均原子级持久化保存为标准 JSON 备份文件；
  - 支持通过 CLI 命令行或配置一键合并导入历史备份，换设备不丢数据。
- 📪 **智能站内信自动清理**
  - 抽奖途中及任务结束自动清理「幸运大转盘 中奖通知」站内信，收件箱保持清爽；
  - 精准匹配主题，**绝不误删「种子被删除」「魔力变动」等重要系统信件**。
- ⚡ **完善的防风控机制**
  - 动态请求间隔抖动（Jitter），消除固定频率特征；
  - 遇站点频率限制（Rate Limit）自动开启指数级退避重试。

---

## 🚀 部署与使用教程

### 方式一：青龙面板部署（推荐）

#### 1. 添加订阅或新建任务
- **命令 / 脚本链接**：
  ```bash
  ql raw https://raw.githubusercontent.com/Agonie0v0/HH-Automatic-lottery/main/qinglong/hh_lottery.js
  ```
- **定时规则**：
  - 定量抽奖模式：`5 9 * * *`（每天早上 9:05 自动执行）
  - 持续挂机模式：`0 0 1 1 *`（手动点击运行一次即可在后台持续常驻）

#### 2. 配置青龙环境变量
在青龙面板的「环境变量」中添加相应配置：

| 环境变量名 | 示例值 | 说明 |
| :--- | :--- | :--- |
| `HH_COOKIE` | `c_secure_uid=...; c_secure_pass=...` | **（必填）** 站点完整登录 Cookie |
| `HH_CONTINUOUS` | `true` | **开启后台持续挂机模式**（`true` 或 `false`） |
| `HH_DRAWS` | `0` | 抽奖次数（填 `0` 表示一抽到底 / 无限抽） |
| `HH_RESERVE` | `0` | 憨豆保留底线（低于此数值时休眠等待） |
| `HH_INTERVAL` | `8` | 每抽间隔（秒，建议保持 8 秒以上防风控） |
| `HH_MAX_MINUTES` | `0` | 单次运行时间上限（分钟，持续挂机建议设为 `0` 不限时） |
| `HH_REPORT_INTERVAL` | `60` | 定期推送战报间隔（分钟，`60` = 1小时） |
| `HH_NOTIFY_BIG_PRIZE` | `true` | 大奖即时通知总开关（`true` 或 `false`） |
| `HH_NOTIFY_INVITE` | `false` | **抽中「邀请」是否推送大奖通知**（设为 `false` 则抽到邀请不通知） |
| `HH_NOTIFY_VIP` | `true` | **抽中「VIP」是否推送大奖通知**（`true` 或 `false`） |
| `HH_BIG_PRIZE_MIN` | `780000` | **触发大奖推送的憨豆数门槛**（默认 78w，设为 `0` 则不按憨豆推大奖） |
| `HH_CLEAN_MAIL` | `true` | 是否自动清理抽奖产生的系统站内信 |

---

### 方式二：Linux / NAS / 本地命令行运行

确保安装了 **Node.js 18+**：

```bash
# 1. 克隆或下载脚本
curl -fLO https://raw.githubusercontent.com/Agonie0v0/HH-Automatic-lottery/main/qinglong/hh_lottery.js

# 2. 首次运行自动生成配置文件模板
node hh_lottery.js

# 3. 编辑配置文件填入 Cookie 与选项
nano hh_lottery.config.json

# 4. 后台常驻运行（使用 nohup）
nohup node hh_lottery.js > hh_lottery.log 2>&1 &

# 或使用 PM2 进程守护（推荐）
pm2 start hh_lottery.js --name hh-lottery
```

---

## ⚙️ 配置文件说明

支持三种配置方式，加载优先级为：
**`hh_lottery.config.json`（外置文件） > 环境变量（`HH_*`） > 脚本内部 `CONFIG`**

### 外置配置文件 `hh_lottery.config.json` 模板
```json
{
    "//": "配置放置于此，更新覆盖脚本时不会丢失。各参数含义详见下表",
    "cookie": "在这里粘贴你的完整 Cookie",
    "draws": 0,
    "continuous": true,
    "reserve": 0,
    "interval": 8,
    "maxMinutes": 0,
    "sleepOnLowMinutes": 10,
    "notifyBigPrize": true,
    "notifyInvite": true,
    "notifyVip": true,
    "bigPrizeMinBeans": 780000,
    "reportIntervalMinutes": 60,
    "cleanMail": true,
    "statsFile": "hh_lottery_stats.json",
    "timezone": "Asia/Shanghai",
    "host": "hhanclub.net"
}
```

### 完整配置参数表

| 配置项 | 默认值 | 对应环境变量 | 说明 |
| :--- | :--- | :--- | :--- |
| `cookie` | 空 | `HH_COOKIE` | **必填**，站点完整登录 Cookie |
| `continuous` | `false` | `HH_CONTINUOUS` | **后台持续挂机模式**。为 `true` 时无憨豆自动休眠等待做种，后台常驻 |
| `draws` | `10` | `HH_DRAWS` | 每次运行抽多少次。**填 `0` 表示一抽到底** |
| `reserve` | `0` | `HH_RESERVE` | 保留憨豆底线（余额低于该值停止或休眠） |
| `interval` | `8` | `HH_INTERVAL` | 单抽间隔（秒，建议不低于 5 秒防风控） |
| `maxMinutes` | `60` | `HH_MAX_MINUTES` | 单次运行最长时间（分钟）。**持续挂机建议设为 `0`（不限时长）** |
| `sleepOnLowMinutes` | `10` | `HH_SLEEP_ON_LOW` | 持续模式下，余额不足时的休眠检查间隔（分钟） |
| `notifyBigPrize` | `true` | `HH_NOTIFY_BIG_PRIZE`| 大奖即时推送总开关 |
| `notifyInvite` | `true` | `HH_NOTIFY_INVITE` | **抽中「邀请」是否推送大奖通知**（填 `false` 则抽到邀请不通知） |
| `notifyVip` | `true` | `HH_NOTIFY_VIP` | **抽中「VIP」是否推送大奖通知** |
| `bigPrizeMinBeans` | `780000` | `HH_BIG_PRIZE_MIN` | **触发大奖推送的憨豆数门槛**（默认 780,000 即 78w） |
| `reportIntervalMinutes`| `60` | `HH_REPORT_INTERVAL` | 运行中每隔多少分钟推送一次统计简报（`0` 表示不发周期简报） |
| `cleanMail` | `false` | `HH_CLEAN_MAIL` | 抽奖过程中与结束时自动清理抽奖站内信 |
| `statsFile` | `hh_lottery_stats.json` | `HH_STATS_FILE` | 历史统计持久化文件名（留空 `""` 表示不存盘） |
| `importFile` | 空 | `HH_IMPORT_FILE` | 启动前要自动合并导入的历史备份文件路径 |
| `timezone` | `Asia/Shanghai` | `HH_TIMEZONE` | 日志和通知时间的显示时区 |

---

## 🎯 常用使用场景推荐

### 场景 1：24 小时全自动做种回血抽奖（推荐）
* `continuous`: `true`
* `draws`: `0`
* `maxMinutes`: `0`
* `reportIntervalMinutes`: `60`（每小时推送一次时段汇总）
* `cleanMail`: `true`

### 场景 2：每日定时定量抽奖
* `continuous`: `false`
* `draws`: `50`
* `cleanMail`: `true`
* 青龙 Cron 定时：`5 9 * * *`（每天 09:05 自动执行）

---

## 💾 数据导入与备份

1. **自动备份**：每次抽奖与任务退出时，统计数据均会自动原子写入 `hh_lottery_stats.json`。
2. **合并导入历史记录**：
   ```bash
   # 通过命令行参数一键合并导入
   node hh_lottery.js --import /path/to/backup.json
   ```

---

## 📱 推送通知样式展示

### 1. 命中大奖即时推送
```text
🎉 HHCLUB 幸运大转盘｜命中大奖

╭─ 🎊 欧皇降临
│ 命中大奖：⭐ VIP（已自动折算 1,000,000 憨豆）
│ 中奖时间：08/21 00:30:15
│ 当前抽数：本次第 520 抽
╰─ 历史累计：3,250 抽
━━━━━━━━━━━━━━━━━━━
📊 本次运行数据
  🎲 已抽：520 抽
  🔥 消耗：1,040,000 憨豆
  🎁 获得：1,850,000 憨豆（含 VIP 折算）
  🚀 净盈亏：+810,000（+77.9%）
  💰 当前余额：4,860,200 憨豆
━━━━━━━━━━━━━━━━━━━
🌟 后台持续挂机抽奖中
```

### 2. 定期统计战报（支持增量与总量同屏对比）
```text
📊 HHCLUB 幸运大转盘｜定时战报

╭─ ⏰ 播报概览
│ 统计区间：近 60 分钟
│ 持续运行：2小时 15分
╰─ 播报时间：08/21 01:00:00
━━━━━━━━━━━━━━━━━━━
⚡ 此次播报增量
  🎲 抽奖：+420 抽
  🔥 消耗：-840,000 憨豆
  🎁 获得：+1,150,000 憨豆（含折算 1,000,000）
  🚀 净盈亏：+310,000（+36.9%）
━━━━━━━━━━━━━━━━━━━
🎁 此次奖品明细
  💰 憨豆｜380 次 · 150,000 憨豆
     └ 100 憨豆 × 300
     └ 1,000 憨豆 × 70
     └ 5,000 憨豆 × 10
  ⭐ VIP｜1 次 · 折算 1,000,000 憨豆
━━━━━━━━━━━━━━━━━━━
🏆 历史累计总量（含此次增量）
  🎲 抽奖：4,200 抽
  🔥 消耗：8,400,000 憨豆
  🎁 获得：9,230,000 憨豆（含折算 2,000,000）
  🚀 净盈亏：+830,000（+9.9%）
━━━━━━━━━━━━━━━━━━━
📜 历史奖品明细
  💰 憨豆｜3,680 次 · 2,450,000 憨豆
  ⭐ VIP｜3 次 · 7 天 · 折算 2,000,000 憨豆
  🌈 彩虹ID｜18 次 · 63 天
  🎫 补签卡｜85 次 · 85 个
  📤 上传量｜414 次 · 1,260 GB
━━━━━━━━━━━━━━━━━━━
🌟 后台持续监控与抽奖中 · 下次播报约 60 分钟后
```

---

## 🔑 Cookie 获取方法

1. 使用桌面浏览器登录 `hhanclub.net`；
2. 按 `F12` 打开开发者工具，切换到 **Network（网络）** 标签页；
3. 刷新页面或点击任意请求，在右侧 **Request Headers（请求头）** 中找到 `Cookie:` 整行；
4. 将整行内容完整复制，填入配置文件或青龙环境变量 `HH_COOKIE` 中即可。

---

## 🧪 自动化测试

项目内置完整的 Mock 端到端集成测试套件：

```bash
npm test
```

覆盖 41 项业务场景与边界测试，共 168 条断言全部通过。

---

## 📄 开源协议

本项目基于 [MIT 协议](LICENSE) 开源。仅供学习与个人自动化管理使用。

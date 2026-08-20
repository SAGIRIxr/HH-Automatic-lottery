# HHCLUB 幸运大转盘 · 全自动挂机与通知版

针对 PT 站点 **HHCLUB（憨憨 / hhanclub.net）**「幸运大转盘」的全功能自动化抽奖与挂机监控工具。

专为**青龙面板（Qinglong）**与**服务器 / NAS / 本地命令行环境**打造。支持 24 小时后台常驻挂机、做种自动休眠复苏、大奖即时推送通知、小时级中奖简报、历史记录导出与合并导入，以及智能站内信清理。

> **依赖环境**：Node.js 18+（原生内置 `fetch`，**无需 `npm install` 任何第三方依赖包**）。

---

## 🌟 核心特性

* 🔄 **后台持续挂机（Continuous 模式）**：
  * 支持 24 小时后台常驻运行；
  * 当憨豆不足或低于保留底线时，自动进入休眠等待（默认 10 分钟），周期性检测做种收益，一旦有豆自动继续抽奖，无需人工干预。
* 🎉 **命中大奖即时通知**：
  * 抽中 **📧 邀请码**、**⭐ VIP（或 VIP 折算 100W 憨豆）**、**💰 78w+ 憨豆** 等稀有大奖时，**第一时间触发青龙多通道消息推送**！
* 📊 **定时周期统计简报**：
  * 支持设置每隔 1 小时（或自定义分钟）推送一次时段战报，每次都同时展示「此次播报增量」和「历史累计总量」。
* 📱 **通知防重与兜底**：
  * 优先调用青龙 `sendNotify`；只有它不可用或发送失败时，才使用 Telegram Bot 直连兜底，避免同一通知重复送达。
  * 脚本会关闭青龙 `sendNotify` 默认追加的「一言」随机标语，通知只保留抽奖数据。
* 💾 **历史记录导出与合并导入**：
  * 每次抽奖均会自动落盘为标准 JSON 备份文件；
  * 支持使用命令行 `node hh_lottery.js --import <backup.json>` 一键合并导入历史备份数据，换设备不丢战绩。
* 👑 **智能 VIP 等级折算识别**：
  * 站点规则：当已经是 VIP 或更高等级的用户中 VIP 时，站点改发 1,000,000 憨豆；
  * 脚本自动按等级图标判定，自动折算收益并修正统计，避免百万憨豆凭空蒸发。
* 📪 **智能站内信自动清理**：
  * 抽奖途中每 25 抽批量清理首页，任务结束全量扫描；
  * 精准匹配「幸运大转盘」主题，**绝不误删「种子被删除」「魔力变动」等重要系统信**。
* 🛡️ **完善的抗风控与异常保护**：
  * 随机抖动请求间隔（Jitter）消除固定频率特征；
  * 遭遇频率限制（Rate Limit）自动指数级退避延时；
  * 主动接管青龙预加载的 `SIGTERM` 立即退出处理器；手动停止时先落盘数据，优先快速直连 Telegram，确认推送完成后再退出。

---

## 🚀 部署与使用

### 1. 青龙面板（推荐）

#### 步骤 ①：添加脚本任务
在青龙面板的「定时任务」中新建任务：
* **名称**：`HHCLUB幸运大转盘`
* **命令**：`ql raw https://raw.githubusercontent.com/Agonie0v0/HH-Automatic-lottery/main/qinglong/hh_lottery.js`
* **定时规则**：`5 9 * * *`（如果开启了 `HH_CONTINUOUS=true` 持续挂机模式，运行一次后将常驻后台）。

#### 步骤 ②：配置环境变量
在青龙面板的「环境变量」中添加：

| 环境变量名 | 示例值 | 说明 |
| :--- | :--- | :--- |
| `HH_COOKIE` | `c_secure_uid=...; c_secure_pass=...` | **（必填）** 站点完整 Cookie |
| `HH_CONTINUOUS` | `true` | **开启后台持续挂机模式**（`true` 或 `false`） |
| `HH_DRAWS` | `0` | 抽奖次数（`0` 表示一抽到底 / 无限抽） |
| `HH_MAX_MINUTES` | `0` | 单次运行时间上限（分钟，`0` 表示不限时长） |
| `HH_RESERVE` | `0` | 憨豆保留底线（低于此数值时休眠等待） |
| `HH_REPORT_INTERVAL` | `60` | 定期推送运行简报间隔（分钟，`60` = 1小时） |
| `HH_NOTIFY_BIG_PRIZE` | `true` | 抽中 邀请/VIP/78w 憨豆时是否即时推送 |
| `HH_BIG_PRIZE_MIN` | `780000` | 大奖憨豆门槛（默认 78w） |
| `HH_CLEAN_MAIL` | `true` | 是否自动清理抽奖产生的系统站内信 |

---

### 2. Linux / NAS / 群晖 / 命令行直接运行

只需 Node.js 18+ 环境：

```bash
# 1. 下载脚本
curl -fLO https://raw.githubusercontent.com/Agonie0v0/HH-Automatic-lottery/main/qinglong/hh_lottery.js

# 2. 首次运行生成配置文件模板
node hh_lottery.js

# 3. 编辑生成的 hh_lottery.config.json 填入 Cookie 和配置
nano hh_lottery.config.json

# 4. 后台常驻启动（使用 nohup）
nohup node hh_lottery.js > hh_lottery.log 2>&1 &

# 或使用 PM2 守护进程
pm2 start hh_lottery.js --name hh-lottery
```

---

## ⚙️ 配置说明

支持三种配置方式，加载优先级为：
**`hh_lottery.config.json`（外置文件） > 环境变量（`HH_*`） > 脚本内部 `CONFIG`**

### 外置配置文件 `hh_lottery.config.json` 模板
```json
{
    "//": "配置放这里，更新脚本时不会被覆盖",
    "cookie": "在这里粘贴你的 Cookie",
    "continuous": true,
    "draws": 0,
    "maxMinutes": 0,
    "reserve": 0,
    "interval": 8,
    "sleepOnLowMinutes": 10,
    "notifyBigPrize": true,
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
| `cookie` | 无 | `HH_COOKIE` | **必填**，站点完整登录 Cookie |
| `continuous` | `false` | `HH_CONTINUOUS` | **后台持续挂机模式**。为 `true` 时无憨豆自动休眠等待做种，后台常驻 |
| `draws` | `10` | `HH_DRAWS` | 每次抽多少次。**填 `0` 表示一抽到底** |
| `reserve` | `0` | `HH_RESERVE` | 保留憨豆底线（余额低于该值停止或休眠） |
| `interval` | `8` | `HH_INTERVAL` | 单抽间隔（秒，建议不低于 5 秒防风控） |
| `maxMinutes` | `60` | `HH_MAX_MINUTES` | 单次运行最长时间（分钟）。**持续挂机建议设为 `0`（不限时长）** |
| `sleepOnLowMinutes` | `10` | `HH_SLEEP_ON_LOW` | 持续模式下，余额不足时的休眠检查间隔（分钟） |
| `notifyBigPrize` | `true` | `HH_NOTIFY_BIG_PRIZE`| 抽中大奖（邀请 / VIP / 78w 憨豆）时立即推送通知 |
| `bigPrizeMinBeans` | `780000` | `HH_BIG_PRIZE_MIN` | 触发大奖推送的憨豆数门槛（默认 780,000） |
| `reportIntervalMinutes`| `60` | `HH_REPORT_INTERVAL` | 运行中每隔多少分钟推送一次统计简报（`0` 表示不发周期简报） |
| `cleanMail` | `false` | `HH_CLEAN_MAIL` | 抽奖过程中与结束时自动清理抽奖站内信 |
| `statsFile` | `hh_lottery_stats.json` | `HH_STATS_FILE` | 历史统计持久化文件名（留空 `""` 表示不存盘） |
| `importFile` | 无 | `HH_IMPORT_FILE` | 启动前要自动合并导入的历史备份文件路径 |
| `timezone` | `Asia/Shanghai` | `HH_TIMEZONE` | 日志和通知时间的时区 |

---

## 💾 历史记录导入与导出

### 1. 自动导出
每次抽奖、周期简报以及脚本正常/异常退出时，数据均会**自动原子安全落盘**至 `hh_lottery_stats.json`。

### 2. 合并导入历史记录
如果你在其他设备或历史上有备份的统计 JSON 文件，可通过以下方式一键合并导入：

```bash
# 方式 ①：通过命令行参数导入
node hh_lottery.js --import /path/to/backup.json

# 方式 ②：在配置文件中指定 importFile
# 在 hh_lottery.config.json 中配置 "importFile": "backup.json"
```

导入时会自动将历史抽数、各奖品中奖次数、档位明细与盈亏数据完整累加合并。

---

## 📱 推送通知样式展示

### 1. 命中大奖即时推送
```text
🎉 HHCLUB 幸运大转盘｜命中大奖

╭─ 🎊 欧皇降临
│ 命中大奖：⭐ VIP（已自动折算 1,000,000 憨豆）
│ 中奖时间：08/20 16:30:15
│ 当前抽数：本次第 520 抽
╰─ 历史累计：3,250 抽
━━━━━━━━━━━━━━━━━━━
📊 本次运行数据
  🎰 已抽：520 抽
  💸 消耗：1,040,000 憨豆
  🎁 获得：1,850,000 憨豆（含 VIP 折算）
  📈 净盈亏：+810,000（+77.9%）
  💵 当前余额：4,860,200 憨豆
━━━━━━━━━━━━━━━━━━━
🤖 后台持续挂机抽奖中
```

### 2. 每小时定期统计简报
```text
📊 HHCLUB 幸运大转盘｜定时战报

╭─ ⏱️ 播报概览
│ 统计区间：近 60 分钟
│ 持续运行：2小时 15分
╰─ 播报时间：08/20 17:00:00
━━━━━━━━━━━━━━━━━━━
🆕 此次播报增量
  🎰 抽奖：+420 抽
  💸 消耗：-840,000 憨豆
  🎁 获得：+1,150,000 憨豆（含折算 1,000,000）
  📈 净盈亏：+310,000（+36.9%）
━━━━━━━━━━━━━━━━━━━
🎁 此次奖品明细
  💰 憨豆｜380 次 · 150,000 憨豆
     └ 100 憨豆 × 300
     └ 1,000 憨豆 × 70
     └ 5,000 憨豆 × 10
  ⭐ VIP｜1 次 · 折算 1,000,000 憨豆
━━━━━━━━━━━━━━━━━━━
🏆 历史累计总量（含此次增量）
  🎰 抽奖：4,200 抽
  💸 消耗：8,400,000 憨豆
  🎁 获得：9,230,000 憨豆（含折算 2,000,000）
  📈 净盈亏：+830,000（+9.9%）
━━━━━━━━━━━━━━━━━━━
🗂️ 历史奖品明细
  💰 憨豆｜3,680 次 · 2,450,000 憨豆
  ⭐ VIP｜3 次 · 7 天 · 折算 2,000,000 憨豆
  🌈 彩虹ID｜18 次 · 63 天
  🎫 补签卡｜85 次 · 85 个
  ⬆️ 上传量｜414 次 · 1,260 GB
━━━━━━━━━━━━━━━━━━━
🤖 后台持续监控与抽奖中 · 下次播报约 60 分钟后
```

---

## 🔑 Cookie 获取方法

1. 使用桌面浏览器登录 `hhanclub.net`；
2. 按 `F12` 打开开发者工具，切换到 **Network（网络）** 标签页；
3. 刷新页面或点击任意请求，在右侧 **Request Headers（请求头）** 中找到 `Cookie:` 整行；
4. 将整行内容完整复制，填入配置文件或青龙环境变量 `HH_COOKIE` 中即可。

---

## 🧪 单元与集成测试

项目包含完整的端到端 Mock 模拟测试：

```bash
npm test
```

覆盖 41 项专项场景测试，共 167 条断言。

---

## 📄 开源协议

本项目基于 [MIT 协议](LICENSE) 开源。仅供学习与个人自动化管理使用。

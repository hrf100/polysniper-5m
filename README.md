# PolySniper 5m · BTC 5 分钟盘绝地反转狙击终端

Polymarket BTC 5m Up/Down 二元盘的「深虚值反转」**模拟**交易终端：实时接入 Chainlink RTDS、Binance aggTrade/1m K 线、Polymarket CLOB 盘口，按翻转分自动执行 $5 单元模拟狙击，并在盘中 2.5x 时平半仓抽本（Free-Roll）。

## 架构

- **策略服务 `strategyService.ts`（服务端常驻）**：行情 WebSocket（含断线重连与 30s 静默看门狗）、CLOB 1s 轮询、1s 主循环、模拟账本。**与页面是否打开无关，7×24 运行**；账本/资金/参数落盘到 `data/strategy-state.json`，重启自动恢复。
- **服务端 `server.ts`**：Express，负责访问鉴权、SSE 推送（`/api/strategy/stream`）、策略控制接口、钱包相关代理、系统指标、静态资源。
- **前端（浏览器）**：仅观察与调参。参数修改、手动下单、重置账本都会提交到服务端执行。

## 策略要点

- 入场：剩余 65–245s、劣势方卖一 ≤ `maxEntryCents`、翻转分 ≥ `minReversalScore`、单周期限 1 笔。
- 自动入场与半仓抽本**只使用实盘 CLOB 报价**；CLOB 不可用时仅显示模型估算价，不成交。临近结算时必胜方无卖单视为 99¢，劣势方真实卖一仍有效。
- Strike / 结算价与 Polymarket 页面「目标价格」同源：Chainlink 在开盘/收盘那一秒的报价。优先取 RTDS 中时间戳精确等于边界秒的报价，缺失时回退官方接口 `polymarket.com/api/crypto/crypto-price`（中途启动也能立即取得）。Strike 确认前不自动狙击。
- 结算按每笔交易自身 Strike；15 分钟内仍取不到官方收盘价的持仓按「未翻转」保守记账。
- 时间窗口按 Binance 事件时间校准，本地时钟偏差不影响开/收盘判定。

## 本地开发

前置：Node.js ≥ 22.9

```bash
npm install
npm run dev        # http://localhost:3000，默认密码 qq111111
npm test           # 单元测试
npm run lint       # 类型检查
```

## 一行命令部署（推荐）

在 **Linux VPS**（Debian/Ubuntu，含 1C1G）上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/hrf100/polysniper-5m/main/deploy.sh | sudo bash
```

脚本会自动：安装 Node 22、必要时加 1G swap、克隆仓库、构建、写入 systemd、启动服务。安装目录默认 `/opt/polysniper`，端口 `3000`，默认密码 `qq111111`。

常用覆盖：

```bash
AUTH_PASSWORD='你的密码' PORT=3000 \
  curl -fsSL https://raw.githubusercontent.com/hrf100/polysniper-5m/main/deploy.sh | sudo bash
```

更新到最新代码：再执行同一条命令即可（保留已有 `.env` 与 `data/`）。

手动查看：`systemctl status polysniper` · 日志：`journalctl -u polysniper -f`

生产实测常驻内存约 65MB。`systemctl stop` 发送 SIGTERM 时会先把策略状态写盘再退出。

## 配置项（`.env`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `AUTH_PASSWORD` | `qq111111` | 访问密码，修改后所有会话失效 |
| `AUTH_SECRET` | 空 | 可选，混入会话签名 |
| `TRUST_PROXY` | `loopback` | 仅信任本机反代的 `X-Forwarded-For` |
| `DATA_DIR` | `./data` | 策略状态持久化目录 |
| `DISPLAY_TZ` | `Asia/Shanghai` | 周期标签/入场时间显示时区 |

## 访问验证

- 未登录访问页面跳转 `/login`，API 返回 401；登录有效期 7 天（HttpOnly Cookie），右上角可退出。
- 同一 IP 10 分钟内失败 5 次即锁定。
- 鉴权为明文传输，公网部署请在前面加 HTTPS 反代（Caddy/Nginx）。

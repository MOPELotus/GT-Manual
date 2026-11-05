# GT-Manual

Geetest v3 / v4 人工验证页与一次性结果中转。机器人遇到验证码时创建链接，用户在浏览器完成验证，机器人领取结果后继续原业务。

本站只提供验证页面，不包含个人主页、音乐、热榜或签到功能；不依赖 Python、Redis 或 WebSocket。验证结果被中转成功不等于签到、查询或兑换成功，最终结果由调用方确认。

## 部署

需要 Node.js 20 或更新版本。

```sh
npm install --omit=dev
npm start
```

默认监听 `127.0.0.1:7833`。需要进程守护时可使用 `pm2 start app.js --name GT-Manual`。对外部署建议使用 Apache 或其他反向代理提供 HTTPS。

在 `config/config/http.yaml` 保存监听配置：

```yaml
HOST: '127.0.0.1'
HTTP_PORT: 7833
PUBLIC_ADDRESS: 'https://captcha.example.com'
ALLOWED_ORIGINS: []
```

需要在独立服务上使用子路径时，可增加 `BASE_PATH: '/lotus/gt'`。`PUBLIC_ADDRESS` 仍填写公开 origin；页面、资源、注册与结果接口都会使用该子路径。

宿主可导入 `lib/server.js` 的 `createVerificationHandler({ config })` 并挂载到自己的 HTTP 服务，无需另开端口。配置由 `normalizeConfig` 生成，挂载路径与 `BASE_PATH` 保持一致；卸载时调用处理器的 `close()` 清理任务。独立部署继续使用 `npm start`。

`PUBLIC_ADDRESS` 用于生成用户链接，填写浏览器实际访问的完整 origin，不带路径。HTTPS 经代理转发到本机 HTTP 服务时，这里仍填写外部 HTTPS 地址。

提交来源默认接受配置的公开地址、同一配置域名的默认 HTTP/HTTPS 入口，以及实际同源的 IP/域名直连。特殊别名或非默认端口可逐项填写 `ALLOWED_ORIGINS`，例如 `https://captcha-alt.example.com:8443`。只接受完整 HTTP(S) origin，不接受路径、通配符或任意外站。代理如保留请求 Host，可在本机转发时设置 `X-Forwarded-Proto: https`；只有来自 loopback 的代理连接会使用此协议头。

在 `config/page/GTest.yaml` 保存页面与任务配置：

```yaml
REGISTER_KEY: '请换成自己的随机密钥'
TTL_MS: 180000
RESULT_TTL_MS: 30000
MAX_TASKS: 1000
ICP_NUMBER: ''
```

`ICP_NUMBER` 填写本站备案号后，页脚显示备案号并链接到工信部备案查询；留空不显示页脚。页面不显示项目或作者署名。

注册密钥仅供机器人使用，不能放在用户链接或公开页面中。配置密钥为空会允许免鉴权注册，不适合公开部署。账号凭据、配置文件及验证票据不要提交到仓库。

## 接入机器人

向 `POST /GTest/register?key=<REGISTER_KEY>` 提交 JSON。

v3：

```json
{"gt":"站点标识","challenge":"本次业务的新挑战"}
```

v4：

```json
{"captchaVersion":4,"captchaId":"站点标识","riskType":"原业务提供的完整参数"}
```

v4 的 `riskType` 可省略；如原业务提供，则原样传递。也接受 `captcha_id`、`risk_type` 别名及明确提供的 `userInfo`。不会把 v4 参数转换成 v3。

成功响应的 `data.link` 交给用户，`data.result` 由机器人至少间隔 1500 毫秒轮询。响应同时包含 `expires_in_ms`、`expires_at`。用户点击开始后链接只认领一次；完成、关闭、失败或超时后，应由机器人重新获取业务挑战并创建新链接。

| 接口 | 用途 |
| --- | --- |
| `GET /healthz` | 服务健康与支持版本 |
| `POST /GTest/register` | 鉴权注册任务 |
| `GET /GTest/<id>` | 人工验证页 |
| `GET /GTest/register/<id>` | 页面一次性领取参数 |
| `POST /GTest/validate/<id>` | 页面提交证明 |
| `POST /GTest/fail/<id>` | 页面报告关闭或失败 |
| `GET /GTest/validate/<id>` | 机器人领取结果；终态只领取一次 |

等待中的结果为 `{status:0,data:{}}`。v3 成功结果含 `challenge`、`validate`、`seccode`；v4 含 `captchaVersion`、`captchaId`、`lotNumber`、`captchaOutput`、`passToken`、`genTime`。失败结果含 `ok:false` 和 `reason`。HTTP 410 表示不存在、过期清理或结果已领取；409 表示已认领或任务状态冲突；403 表示鉴权或来源校验未通过。

页面通过官方 SDK 获取证明，不直接执行米游社业务，也不会自动把证明视作业务成功。调用方须完成自己的二次校验，并且不得重用已经尝试过的挑战或证明。

## 从旧版升级

先保存本地配置，更新源码后执行 `npm install --omit=dev` 并重启进程。已有用户配置不会被默认模板覆盖。

监听配置优先读取 `config/config/http.yaml`，兼容旧 `config/server.yaml`，最后使用默认模板。页面配置读取 `config/page/GTest.yaml`；旧 `config/page/home.yaml` 中的 `SITE_ICP` 可继续作为备案号回退值。任务只存于内存，重启前创建的链接会失效。

旧版的内置 HTTPS、主页、音乐及其他业务已移除。HTTPS 请交给反向代理，旧配置中的 `HTTPS: true` 需要迁移。旧 Redis、其他网站及外部服务不会由本项目停止或卸载。

## 来源与许可证

原验证页作者为 **Hlhs**，原项目：[Hlhs / GT-Manual](https://gitee.com/QQ1146638442/GT-Manual)。本仓库由 MOPELotus 基于其验证页重写并维护，保留原项目 [GPL-3.0 许可证](LICENSE)。

SDK 与协议参考：[Geetest v3 文档](https://docs.geetest.com/captcha/) · [Geetest v4 文档](https://docs.geetest.com/gt4/deploy/client/web)。

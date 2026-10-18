# dsh-web-restart-button

给跑在 Docker 里的 **DeepSeek Harness（dsh）** 加一个页面上的重启按钮。

右下角一个小圆钮 → 点一下确认 → 全屏遮罩转圈 → 约 10 秒后自动回到主界面。

```
        ┌─ 浏览器 ─┐
        │  [ ⟳ ]   │  右下角悬浮按钮（注入进页面）
        └────┬─────┘
             │ 1. 点击 → 确认气泡
             ▼
        nginx (HTTP Basic Auth)
             │ 2. GET /__restart
             ▼
     restart-endpoint.js :8099  (仅监听 127.0.0.1)
             │ 3. pkill -f "dsh web"
             ▼
     entrypoint: wait $DSH_PID 结束 → 容器退出
             │ 4. Docker restart: unless-stopped
             ▼
     整套重建（dsh + nginx + 新的 launch token）
             │ 5. 前端轮询到 /login 200
             ▼
        location.replace('/')
```

## 为什么需要它

**dsh 本身没有重启入口。** 把整包扫一遍可以确认：

- `/api/*restart*` 路由 **0 个**，服务端根本没暴露
- 前端出现的 restart 字样都不是重启服务：`restartActionLabel` 是连接指示器里"重连"按钮的无障碍标签；`desktop.update.ready`（安装并重启）只有 macOS/Windows 桌面端才有
- 插件管理器里的 `restartRequired` = "更改将在下次启动生效" —— **只提示，不给按钮**

**社区"重启插件"在容器里实测全部失效：**

| 插件 | npm | 实测 |
|---|---|---|
| `dsh-power-button` 0.1.0 | 存在 | `/dsh-power/health` **404** —— 桌面端 GUI 专用，web profile 下不注册路由 |
| `dsh-restart-button` 0.1.2 | 存在 | 装上后 **dsh 起不来**，容器反复重启 |

根因是机制不匹配：这类插件靠"detached helper 杀掉进程再按原命令行拉起"，前提是桌面启动器或 systemd —— 容器里两样都没有。

## 它不是 dsh 插件

是一层**反代侧的补丁**：一个 127.0.0.1 的控制端点 + 一个注入进页面的脚本。好处是不碰 dsh 的代码，dsh 升级、插件重装都冲不掉它；代价是要能改 nginx 配置和 entrypoint。

## 三个部件

| 文件 | 作用 |
|---|---|
| `restart-endpoint.js` | 监听 `127.0.0.1:8099`，收到任意请求就 `pkill -f "dsh web"`，先回响应再动手 |
| `entrypoint.sh` | **关键**：`nginx &` + `wait $DSH_PID`。dsh 一死脚本就结束、容器退出，Docker 的重启策略接管 |
| `restart-button.js` | 注入页面的悬浮按钮 + 确认气泡 + 重启遮罩 + 恢复轮询 |
| `nginx.conf` | 反代示例：`/__restart` 转发、`/__restart-btn.js` 静态供文件、`sub_filter` 注入 |

> ⚠️ `entrypoint.sh` 里那句 `wait "${DSH_PID}"` 是整套机制的地基。如果原来是 `exec nginx`（nginx 成为 PID 1），dsh 死了容器照样"活着"，后端永远起不来 —— 重启按钮也就只会把服务按死。

## 安装

假设你已经有一个 nginx 反代 dsh 的容器。

**1. 放文件**

```dockerfile
COPY restart-endpoint.js /usr/local/bin/restart-endpoint.js
COPY restart-button.js   /usr/share/nginx/restart-button.js
COPY entrypoint.sh       /usr/local/bin/entrypoint.sh
COPY nginx.conf          /etc/nginx/nginx.conf
```

**2. nginx 加两个 location**（`auth_basic` 之下，所以它俩都受同一道登录保护）

```nginx
location = /__restart-btn.js {
    alias /usr/share/nginx/restart-button.js;
    default_type application/javascript;
}

location = /__restart {
    proxy_pass http://127.0.0.1:8099;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
}
```

**3. 把脚本注入页面**（跟已有的 polyfill 注入同一条通道）

```nginx
# sub_filter 要求上游不要压缩
proxy_set_header Accept-Encoding "";
sub_filter '</head>' '<script src="/__restart-btn.js?v=1"></script></head>';
sub_filter_once on;
```

**4. entrypoint 起端点、并把 dsh 变成"被等待的进程"**

```bash
node /usr/local/bin/restart-endpoint.js > /tmp/restart-endpoint.log 2>&1 &
nginx -c /etc/nginx/nginx.conf &
wait "${DSH_PID}"     # dsh 一退出，容器就退出 → restart policy 重建
```

然后 `docker compose build && docker compose up -d`，刷新页面（`Ctrl+F5`，脚本带版本号）。

`docker-compose.example.yml` 里有一份可直接改的完整例子。

## 踩过的坑（都在代码里注释了）

1. **恢复探测不能用 `/go`。** 装了 `dsh-web-startup-auth` 这类认证插件后，`/go` 的 token 交换会被 dsh 拒（401 JSON），轮询永远等不到"恢复"。改成探测 `/login` —— 恒定 200，不依赖会话。
2. **sub_filter 必须配 `proxy_set_header Accept-Encoding ""`**，否则上游返回 gzip，nginx 改不了 HTML。
3. **改脚本要带版本号** `?v=N`，不然浏览器用缓存，你会以为没生效。
4. **nginx 非 root 运行时要显式写全 5 个 temp path**（client_body / proxy / fastcgi / uwsgi / scgi），否则 `mkdir() "/var/lib/nginx/fastcgi" Permission denied` 让容器不停重启。
5. **登录页不渲染按钮**（脚本里判断 `location.pathname === '/login'`）。

## 安全

- 这个服务**能执行 shell 命令**。`/__restart` 必须留在 `auth_basic` 之下，别开到公网。
- 端点只监听 `127.0.0.1`，除了经 nginx 无路可走 —— 也就是说 Basic Auth 无法被绕过。
- 端点本身不校验任何东西，收到请求就重启。想加限流就在 nginx 那层加。

## 实测环境

- dsh `0.2.0-rc.2`，web profile，Debian bookworm 容器
- 插件：`dsh-web-startup-auth` / `dshmarket` / `dsh-ops` / `meow-memory` / `dsh-bili-scroll`
- 重启往返：**9 秒**（容器重建 + dsh 启动 + 页面恢复）

## License

MIT

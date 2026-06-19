# 部署记录

本文记录 `solo_app` 当前在腾讯云轻量服务器上的部署方式，方便后续更新、迁移和排障。

## 当前线上环境

- 访问地址：http://43.173.101.88
- 云厂商：腾讯云轻量应用服务器
- 系统：OpenCloudOS 9.4
- SSH 用户：`root`
- 项目目录：`/www/solo_app`
- Git 仓库：`https://github.com/chenjiuxuan/solo_app.git`
- 当前部署来源：`origin/master`
- 最近部署提交：`a6660de fix: support deployed music playback and search docs`

## 音频资源

`bgm/*.mp3` 体积较大，已在 `.gitignore` 中排除，不会跟随 GitHub 部署。

当前线上音频文件需要手动保存在：

```text
/www/solo_app/bgm/01.mp3
/www/solo_app/bgm/02.mp3
/www/solo_app/bgm/03.mp3
/www/solo_app/bgm/04.mp3
/www/solo_app/bgm/05.mp3
```

如果重新部署到新机器，除了 `git clone`，还需要额外上传本地 `bgm/*.mp3`：

```bash
scp bgm/*.mp3 root@43.173.101.88:/www/solo_app/bgm/
```

验证音频是否可播放：

```bash
curl -I -H "Range: bytes=0-1023" http://43.173.101.88/bgm/01.mp3
```

正常应返回 `206 Partial Content` 和 `Content-Type: audio/mpeg`。

## 网易云搜索

线上搜索接口：

```text
/api/netease/search
```

服务器环境访问 `https://music.163.com/api/search/get/web` 会返回加密字符串，无法直接解析。因此当前后端使用：

```text
https://music.163.com/api/cloudsearch/pc
```

验证：

```bash
curl "http://43.173.101.88/api/netease/search?keywords=%E6%9D%8E%E7%99%BD&limit=3"
```

搜索结果会尽量过滤出可播放歌曲。部分版权歌曲仍可能无法播放，这是网易云上游限制。

## 运行结构

外部访问走 Nginx 的 80 端口，Nginx 反向代理到本机 Node 服务。

```text
Browser
  -> http://43.173.101.88:80
  -> Nginx
  -> http://127.0.0.1:3001
  -> local-server.mjs
```

说明：

- `3000` 已被服务器上的 Docker 服务占用。
- 本站 Node 服务固定使用内部端口 `3001`。
- `local-server.mjs` 支持 `PORT` 环境变量。

## 已安装组件

```bash
dnf install -y git nodejs npm nginx curl
npm install -g pm2
```

当前主要版本：

```bash
node -v   # v20.20.0
npm -v    # 10.8.2
nginx -v  # nginx/1.26.3
```

## PM2

进程名：`solo-app`

启动命令：

```bash
cd /www/solo_app
PORT=3001 pm2 start local-server.mjs --name solo-app
pm2 save
```

已设置开机自启：

```bash
pm2 startup systemd -u root --hp /root
pm2 save
```

常用命令：

```bash
pm2 status
pm2 logs solo-app --lines 100
pm2 restart solo-app
pm2 delete solo-app
```

## Nginx

配置文件：

```text
/etc/nginx/conf.d/solo_app.conf
```

当前配置：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name 43.173.101.88 _;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

已设置开机自启：

```bash
systemctl enable --now nginx
```

常用命令：

```bash
nginx -t
systemctl reload nginx
systemctl restart nginx
systemctl status nginx
```

## 更新线上站点

本地改完并推送到 GitHub 后，在服务器执行：

```bash
cd /www/solo_app
git fetch origin master
git reset --hard origin/master
npm install
pm2 restart solo-app --update-env
```

验证：

```bash
curl -I http://127.0.0.1:3001
curl -I http://127.0.0.1
curl -I http://43.173.101.88
```

## 首次从零部署命令

新服务器可参考：

```bash
dnf install -y git nodejs npm nginx curl
npm install -g pm2

mkdir -p /www
cd /www
git clone https://github.com/chenjiuxuan/solo_app.git

cd /www/solo_app
npm install

PORT=3001 pm2 start local-server.mjs --name solo-app
pm2 save
pm2 startup systemd -u root --hp /root

cat >/etc/nginx/conf.d/solo_app.conf <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name 43.173.101.88 _;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

nginx -t
systemctl enable --now nginx
systemctl reload nginx
```

## 排障备忘

查看端口占用：

```bash
ss -ltnp | grep -E ':80|:3000|:3001'
```

确认 Node 服务：

```bash
pm2 status
pm2 logs solo-app --lines 100
curl -I http://127.0.0.1:3001
```

确认 Nginx：

```bash
nginx -t
systemctl status nginx
curl -I http://127.0.0.1
```

公网访问不通时，检查：

- 腾讯云轻量服务器防火墙是否放行 `80`
- 系统防火墙是否放行 `80`
- Nginx 是否 active
- PM2 中 `solo-app` 是否 online

## SSH 备注

部署时曾使用临时 ED25519 公钥加入：

```text
/root/.ssh/authorized_keys
```

如果后续不再需要远程自动部署，可以从服务器的 `authorized_keys` 中删除对应 `codex-deploy-solo-app` 的公钥。

查看：

```bash
cat /root/.ssh/authorized_keys
```

删除后重启 SSH：

```bash
systemctl restart sshd
```

## 后续可选

- 绑定域名后，把 `server_name` 改成域名。
- 域名解析到 `43.173.101.88` 后，使用 Let's Encrypt / Certbot 配置 HTTPS。
- 如果后续要保留搜索接口，注意避免添加公共写入接口。

# 部署 CNUsenet

需要 Docker Engine 或 Docker Desktop，以及 Docker Compose v2。同步容器需要能访问配置的 NNTP 服务器 TCP 119 端口。镜像由 GitHub Actions 发布到 `ghcr.io/guohai163/usenet-view`，支持 Linux amd64 和 arm64。

## 启动

在部署主机准备仓库并生成本机配置。如果目录中已有 `.env`，保留现有密码和设置。

```sh
git clone https://github.com/guohai163/usenet-view.git
cd usenet-view
umask 077
test -f .env || sed "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env.example > .env
```

编辑 `.env` 中的 `NNTP_HOST` 和 `NNTP_GROUPS`。模板从 `news.cnusenet.org` 归档 `cn.announce`，多个组用逗号分隔。组名留空时只拉取目录，填 `*` 时同步全部组。`NNTP_INITIAL_LIMIT=0` 会在首次同步时拉取服务器当前保留的整个编号范围，填正数可限制首次拉取范围。

如果 GHCR 包为私有，先用具有包读取权限的 GitHub 账号登录。使用有 `read:packages` 权限的经典个人访问令牌，Docker 会在终端提示输入密码。

```sh
docker login ghcr.io -u YOUR_GITHUB_USERNAME
```

```sh
docker compose config --quiet
docker compose pull
docker compose up -d --wait
docker compose logs -f sync
```

网页默认监听部署主机的 `127.0.0.1:3000`。可用 `WEB_PORT` 修改端口，或把 `WEB_BIND` 设置为指定的主机地址供其他设备访问。Compose 会启动独立的 Web、定时同步和 PostgreSQL 容器。内置 PostgreSQL 使用命名卷 `archive-db`，由应用自动建表。

```sh
curl -fsS http://127.0.0.1:3000/healthz
```

## 使用现有 PostgreSQL

在 `.env` 设置 `DATABASE_URL=postgresql://用户:密码@数据库地址:5432/数据库名`。连接串中的特殊字符需要按 URL 编码。数据库地址须能从容器访问，数据库账号须能建表和读写。保留已生成的 `POSTGRES_PASSWORD` 以通过 Compose 配置解析。

```sh
docker compose pull web sync
docker compose up -d --wait --no-deps web sync
```

## 更新和查看日志

`main` 发布 `latest`，Git 标签（如 `v0.1.0`）发布对应版本，每次发布也有完整提交 SHA 标签（`sha-<完整提交号>`）。可在 `.env` 通过 `USENET_IMAGE` 选择版本。更新使用同一个数据库卷，内置数据库的密码在首次初始化时生效。

```sh
docker compose pull
docker compose up -d --wait
docker compose ps
docker compose logs --tail=100 web sync
```

使用外部数据库时，更新继续使用上一节的两个命令。运行 `docker compose down` 可停止并移除容器，同时保留数据库卷。

## news.cnusenet.org 生产部署

应用配置位于服务器的 `/data/usenet-view`，其中 `docker-compose.override.yml` 将 Web 服务接入 Nginx 的 `shared-network`，网络别名为 `usenet-view-web`。同步任务通过 `news.cnusenet.org:119` 归档全部新闻组。

站点配置位于 `/data/nginx-data/conf.d/news.cnusenet.org.conf`。Nginx 将 HTTP 跳转到 HTTPS，并使用 `/data/nginx-data/certbot/conf/live/news.cnusenet.org/` 下的 Let's Encrypt 证书。证书由服务器现有的 `nginx-data-certbot-renew.timer` 续期。

[GitHub Actions 构建记录](https://github.com/guohai163/usenet-view/actions) · [GitHub Container Registry 镜像](https://github.com/guohai163/usenet-view/pkgs/container/usenet-view)

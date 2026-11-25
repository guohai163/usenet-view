# CNUsenet

CNUsenet 通过 TCP 119 连接 NNTP 服务器，将新闻组目录和文章归档到 PostgreSQL。中文网页使用三窗格阅读布局，支持组名查找、按主题或作者搜索、列排序、讨论串和原文查看。访问接口只接受 GET 和 HEAD。

Docker 镜像和 PostgreSQL 可通过 Compose 启动。 [部署指南](DEPLOY.md)

## 本地运行

准备 Node.js 22 或更新版本，以及一个已创建的 PostgreSQL 数据库。应用首次运行时会自动创建归档表，数据库账号需要在目标 schema 中建表和读写的权限。

```sh
npm ci
cp .env.example .env
```

将 `.env` 中的 `DATABASE_URL` 改为实际连接串。示例使用 `news.cnusenet.org:119`，也可以将 `NNTP_HOST` 改成其他域名、IPv4 或 IPv6 地址。端口固定为 119，支持可直接访问的明文 NNTP 阅读服务。

```sh
npm run sync -- --groups-only
npm run sync -- --group cn.announce
npm start
```

打开 [本地归档页面](http://127.0.0.1:3000)。Web 服务默认只监听本机，可以通过 `WEB_HOST` 和 `WEB_PORT` 修改。

阅读时按 `j` 下一篇、`k` 上一篇。已读状态由当前浏览器保存。已有数据库在启动时会根据已归档的文章原文建立讨论串索引。

## 同步

| 命令或配置 | 用途 |
| --- | --- |
| `npm run sync -- --groups-only` | 只更新新闻组目录 |
| `npm run sync -- --group cn.announce --group cn.admin.doc` | 更新目录并同步指定组，可重复使用 `--group` |
| `NNTP_GROUPS=cn.announce,cn.admin.doc` | 配置要同步的组，供 `npm run sync` 或定时同步使用 |
| `NNTP_GROUPS=*` | 同步来源目录中的全部组 |
| `npm run sync -- --watch` | 启动后立即同步，之后每轮结束等待 `NNTP_SYNC_INTERVAL_SEC` 秒，默认 300 秒 |
| `NNTP_INITIAL_LIMIT` | 默认 `0`，首次同步时从服务器当前保留的最早编号开始。设为正数可只拉取最近指定的编号范围 |
| `NNTP_MAX_ARTICLE_BYTES` | 单篇原始文章的大小上限，默认 64 MiB。超限时该组保留进度，调大后可重试 |

`NNTP_GROUPS` 为空时只同步目录。文章按来源和新闻组记录同步进度，重复同步会从上次的编号继续。已归档文章保留原始字节，网页展示解码后的纯文本。

协议参考 [RFC 3977](https://www.rfc-editor.org/rfc/rfc3977.html)。

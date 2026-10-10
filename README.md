# EdgeOne Pages 版后端（国内直连，替代 Cloudflare）

为什么换：Cloudflare 的 `*.workers.dev` 域名在大陆 DNS 被污染（实测解析到境外 IP、连接超时），
访客发不出统计请求。EdgeOne Pages 用腾讯国内边缘节点，自带二级域名，不用备案。

目录结构（EdgeOne Pages 按 `functions/` 下的目录生成路由）：

```
functions/hit/index.js     →  /hit    计数 + 写设备档案
functions/stats/index.js   →  /stats  读全部站点 + 粘性聚合
index.html                 →  说明首页（不是产品页面）
```

## 和 Cloudflare 版的两个关键差异

1. **KV 是全局变量**，不是 `context.env.HITS`。绑定时的变量名直接变成全局名，
   所以代码里写 `HITS.get(...)`，绑定变量必须填 `HITS`。
2. **key 只用字母数字下划线**：原版的 `total:xxx` 冒号分隔符改成了 `total_xxx`，
   设备标识里的 UUID 连字符也会去掉。返回结构保持一致，本地 `stats.py` 不用改。

## 部署步骤（控制台，约 15 分钟）

1. 注册/登录腾讯云并完成实名：`console.cloud.tencent.com`
2. 控制台搜 **EdgeOne** → 左侧 **Pages 服务** → 立即开通
3. **创建项目** → 从 GitHub 导入 → 首次会要求 GitHub 授权 → 选仓库 `sitehits`
   - 框架预设：选 **Other / 静态**
   - 构建命令：**留空**
   - 输出目录：**`/`**（根目录）
   - 保存并部署
4. **KV 存储**（在 Pages 控制台顶部导航）
   - 点 **KV 存储** → **申请开通** → 理由写「静态站点访问统计与访客粘性分析，读多写少的轻量键值数据」（**需要人工审批，可能要等一会儿**）
   - 开通后 **创建命名空间**，名字填 `sitehits-kv`
   - 回到项目详情 → **KV 存储** → **绑定命名空间** → 变量名填 **`HITS`**（大写）→ 选刚建的命名空间 → 确定
5. 重新部署一次项目（绑定 KV 后需要触发一次构建才生效）
6. 拿到项目的默认域名（形如 `https://xxx.edgeone.app`），验证：
   浏览器打开 `https://xxx.edgeone.app/stats`，返回 JSON 且没有 `error` 字段 = 成功

## 接回本地

```bash
python -c "import json;p='sites.json';c=json.load(open(p,encoding='utf-8'));c['backend']='https://xxx.edgeone.app';json.dump(c,open(p,'w',encoding='utf-8'),ensure_ascii=False,indent=2)"
python stats.py
```

或把这个地址交给 `_set_backend.py` 一并替换九个站埋点里的后端地址。

## 已知限制

- **KV 需要人工审批**，这段时间里 `/stats` 会返回 `KV 未绑定`。
- EdgeOne KV 是最终一致（约 60 秒全球同步），极端并发下计数可能少几个，个人站量级无影响。
- 若将来买了自己的域名，Cloudflare 版（`../worker.js`）仍可作为备份后端，两边返回结构一致，随时切换。

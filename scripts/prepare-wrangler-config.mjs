#!/usr/bin/env node
/**
 * 部署前注入真实资源 ID —— 数据保全的关键一步。
 *
 * 背景：上游 wrangler.toml 的 D1 只写了 database_name、没写 database_id，
 * KV 也只写了 binding、没写 id。若直接部署，wrangler 会新建空库，
 * 线上笔记数据虽然还在旧库里，但应用会指向空库，表现为"数据全丢了"。
 *
 * 因此这里在构建产物 dist/inkstone/wrangler.json 上补齐：
 *   - account_id
 *   - D1(DB)   -> 已有的 inkstone-db 的 UUID（绝不新建）
 *   - KV(OAUTH_KV) -> 固定的命名空间 ID（上游 env.ts 要求必填）
 *   - R2(FILES) -> 保持 inkstone-files（桶不会被重建，附件安全）
 *   - triggers.crons -> 默认关闭（Free 计划每账号仅 5 个 cron，上游默认 2 个）
 *   - workers_dev -> false（只用自定义域名，不启用 *.workers.dev 预览地址）
 *
 * 任何必需的 ID 缺失都会直接抛错终止，绝不带着"可能新建空库"的配置去部署。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const CONFIG_PATH = 'dist/inkstone/wrangler.json'

function must(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `缺少环境变量 ${name}。数据保全要求：必须显式指定已存在的资源 ID，拒绝继续部署。`
    )
  }
  return value
}

const accountId = must('CLOUDFLARE_ACCOUNT_ID')
const d1Id = must('INKSTONE_D1_ID')
const kvId = must('INKSTONE_KV_ID')
const crons = (process.env.INKSTONE_CRONS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const workersDev = (process.env.INKSTONE_WORKERS_DEV ?? 'false') === 'true'

const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))

cfg.account_id = accountId

// ---- D1：绑定已有库（保数据核心）----
const d1 = (cfg.d1_databases ?? []).find((x) => x.binding === 'DB')
if (!d1) {
  throw new Error('配置中找不到 binding=DB 的 D1 绑定，上游结构可能已变化，请人工确认后再部署。')
}
d1.database_id = d1Id
d1.database_name = d1.database_name || 'inkstone-db'

// ---- KV：上游 src/worker/env.ts 里 OAUTH_KV 是必填 ----
const kv = (cfg.kv_namespaces ?? []).find((x) => x.binding === 'OAUTH_KV')
if (!kv) {
  throw new Error(
    '配置中找不到 binding=OAUTH_KV 的 KV 绑定，上游结构可能已变化，请人工确认后再部署。'
  )
}
kv.id = kvId

// ---- R2：桶名固定（附件安全，桶不会被重建）----
for (const bucket of cfg.r2_buckets ?? []) {
  if (bucket.binding === 'FILES') {
    bucket.bucket_name = 'inkstone-files'
  }
}

// ---- cron：默认关闭，避免占用 Free 计划名额导致部署失败 ----
cfg.triggers = { crons }

// ---- 只用自定义域名 ----
cfg.workers_dev = workersDev

writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`)

console.log('===== 部署配置已注入 =====')
console.log('account_id  :', cfg.account_id)
console.log('D1    DB    :', d1.database_name, '->', d1.database_id)
console.log(
  'R2    FILES :',
  (cfg.r2_buckets ?? []).map((b) => `${b.binding}=${b.bucket_name}`).join(', ') || '(无)'
)
console.log('KV    OAUTH :', kv.binding, '->', kv.id)
console.log('crons       :', crons.length ? crons.join(' | ') : '(已关闭)')
console.log('workers_dev :', cfg.workers_dev)
console.log('==========================')

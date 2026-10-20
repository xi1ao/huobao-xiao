import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const ai = read('src/services/ai.ts')
const agents = read('src/agents/index.ts')
const route = read('src/routes/aiConfigs.ts')
const settingsPage = read('../frontend/app/pages/settings.vue')

test('MiniMax 文本走 OpenAI 兼容端点，baseUrl 统一拼 /v1', () => {
  // OpenAI 兼容 Chat Completions = {base}/v1/chat/completions
  // 国内站 base=api.minimaxi.com，国际站 base=api.minimax.io（区域与 Key 必须配套）
  assert.match(ai, /if \(provider === 'minimax'\) \{/)
  assert.match(ai, /joinProviderUrl\(config\.baseUrl, '\/v1', ''\)/)

  // minimax 与 openai 共用同一 base 前缀，但必须各自命中分支（不能落到兜底 return config.baseUrl）
  const baseUrlFn = ai.slice(
    ai.indexOf('export function getTextProviderBaseUrl'),
    ai.indexOf('// Agent 多步循环'),
  )
  const minimaxBranch = baseUrlFn.slice(
    baseUrlFn.indexOf("provider === 'minimax'"),
    baseUrlFn.indexOf('return config.baseUrl'),
  )
  assert.match(minimaxBranch, /provider === 'minimax'/)
  assert.match(minimaxBranch, /joinProviderUrl\(config\.baseUrl, '\/v1', ''\)/)
})

test('MiniMax 文本在白名单内，且不影响其它厂商的既有约束', () => {
  assert.match(ai, /text:\s*\[\s*'openai',\s*'gemini',\s*'volcengine',\s*'minimax'\s*\]/)
  assert.doesNotMatch(ai, /'deepseek'/)
  assert.doesNotMatch(ai, /'ali'/)
  assert.doesNotMatch(ai, /'vidu'/)
  assert.doesNotMatch(ai, /audio:\s*\[/)
})

test('关思考补丁按厂商分化：MiniMax 只发官方支持的 thinking 开关', () => {
  // MiniMax-M3 原生只认 thinking:{"type":"disabled"}
  // enable_thinking(Qwen 系) / reasoning_effort(OpenAI 系) 传官方端点会 400
  assert.match(agents, /function openaiThinkingOffPatch\(providerName\?: string, modelName\?: string\)/)
  assert.match(agents, /if \(providerName === 'minimax'\) \{/)
  assert.match(agents, /return \{ thinking: \{ type: 'disabled' \} \}/)

  // 非 minimax 厂商保持原三参数补丁（new-api 通用 / Qwen / OpenAI 风格）
  const patchFn = agents.slice(
    agents.indexOf('function openaiThinkingOffPatch'),
    agents.indexOf('function createThinkingOffFetch'),
  )
  assert.match(patchFn, /enable_thinking: false/)
  assert.match(patchFn, /reasoning_effort: 'none'/)

  // M3.1-Flash 思考不可关闭（发 thinking:disabled 会 400），故不注入任何思考参数
  assert.match(agents, /function isMinimaxEffortOnlyModel\(modelName\?: string\)/)
  assert.ok(
    agents.includes("return /3\\.1/i.test(modelName || '')"),
    'M3.1 系列判定正则应匹配模型名中的 3.1',
  )
  assert.match(agents, /if \(isMinimaxEffortOnlyModel\(modelName\)\) return \{\}/)
})

test('thinking 补丁链路把 modelName 透传到补丁函数', () => {
  assert.match(
    agents,
    /createThinkingOffFetch\(providerName, resolvedBaseURL, modelName\)/,
  )
  assert.match(
    agents,
    /function createThinkingOffFetch\(providerName: string, baseURL: string, modelName\?: string\)/,
  )
})

test('文本请求对瞬时错误有重试：业务码 2064/1002 + 429/5xx + 网络异常', () => {
  // MiniMax 集群过载 2064 是业务码（拼在 error.message 尾部），SDK 按 HTTP 状态判重试抓不到
  assert.match(agents, /const TRANSIENT_PROVIDER_CODES = \['2064', '1002'\]/)
  assert.match(agents, /function isTransientStatus\(status: number\): boolean/)
  assert.match(agents, /status === 408 \|\| status === 429 \|\| status >= 500/)
  assert.match(agents, /function detectTransientError\(res: Response\)/)
  assert.match(agents, /text\.includes\(`\(\$\{code\}\)`\)/)
  assert.match(agents, /function createTransientRetryFetch\(inner: typeof fetch, providerName: string\): typeof fetch/)

  // 重试在 fetch 层（只重试单次 HTTP 调用），不重试整个 Agent，避免工具写库副作用重复执行
  assert.match(agents, /const fetchImpl = createTransientRetryFetch\(patchedFetch, providerName\)/)
})

test('关闭 SDK 自带重试，避免两层退避叠加放大请求量', () => {
  // 只在 OpenAI 兼容路径（createOpenAI 支持 maxRetries）关闭
  assert.match(agents, /maxRetries: 0,/)
  const openaiIdx = agents.indexOf('createOpenAI({')
  assert.ok(openaiIdx > 0)
  const openaiBlock = agents.slice(openaiIdx, agents.indexOf('return provider.chat(modelName)', openaiIdx))
  assert.match(openaiBlock, /maxRetries: 0/)
  assert.match(openaiBlock, /createTransientRetryFetch/)

  // Gemini 路径保持原样：@ai-sdk/google 未暴露重试次数配置项，也不叠加重试层
  const googleIdx = agents.indexOf('createGoogleGenerativeAI({')
  assert.ok(googleIdx > 0)
  const googleBlock = agents.slice(googleIdx, agents.indexOf('return googleProvider(modelName)', googleIdx))
  assert.doesNotMatch(googleBlock, /maxRetries/)
  assert.doesNotMatch(googleBlock, /createTransientRetryFetch/)
})

test('AI 配置探针：minimax 文本走 GET /v1/models，图片/视频各走各的端点', () => {
  assert.match(route, /if \(p === 'minimax'\) \{/)
  assert.match(route, /if \(serviceType === 'text'\) \{/)
  assert.match(route, /joinProviderUrl\(baseUrl, '\/v1', '\/models'\)/)
  assert.match(route, /if \(serviceType === 'image'\) \{/)
  assert.match(route, /joinProviderUrl\(baseUrl, '\/v1', '\/image_generation'\)/)
  assert.match(route, /joinProviderUrl\(baseUrl, '\/v2', '\/video_generation'\)/)
})

test('前端 MiniMax 文本预设：国内站域名 + 仅暴露 MiniMax-M3', () => {
  assert.match(settingsPage, /const providers = \['gemini', 'openai', 'volcengine', 'minimax', 'aliyun'\]/)
  assert.match(settingsPage, /minimax: \{ label: 'MiniMax 官方', baseUrl: 'https:\/\/api\.minimax\.cn', models: \['MiniMax-M3'\] \}/)

  // 国内站预设不得混入国际站域名
  assert.doesNotMatch(settingsPage, /https:\/\/api\.minimax\.io/)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MiniMaxImageAdapter } from '../src/services/adapters/minimax-image'

const adapter = new MiniMaxImageAdapter()
const config = {
  provider: 'minimax',
  baseUrl: 'https://api.minimax.cn',
  apiKey: 'sk-test',
  model: 'image-01',
}

test('T2I 文生图请求不含 subject_reference、aspect_ratio 由 size=WxH 推导', () => {
  const request = adapter.buildGenerateRequest(config, {
    id: 1,
    prompt: 'A man in a white t-shirt, full-body, standing front view, outdoors, Los Angeles',
    size: '1920x1080',
  })

  assert.equal(request.url, 'https://api.minimax.cn/v1/image_generation')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers['Content-Type'], 'application/json')
  assert.equal(request.headers.Authorization, 'Bearer sk-test')

  // T2I 关键断言：不应携带 subject_reference
  assert.equal(request.body.subject_reference, undefined)
  assert.equal(request.body.model, 'image-01')
  assert.equal(request.body.response_format, 'url')
  assert.equal(request.body.n, 1)
  assert.equal(request.body.aspect_ratio, '16:9') // 1920/1080 ≈ 16/9
})

test('I2I 图生图请求携带 subject_reference[]，type 固定 character', () => {
  const request = adapter.buildGenerateRequest(config, {
    id: 2,
    prompt: 'A girl looking into the distance from a library window',
    size: '1920x1080',
    referenceImages: JSON.stringify([
      'https://cdn.example.com/ref1.jpg',
      'data:image/png;base64,iVBORw0KGgo=',
    ]),
  })

  assert.deepEqual(request.body.subject_reference, [
    { type: 'character', image_file: 'https://cdn.example.com/ref1.jpg' },
    { type: 'character', image_file: 'data:image/png;base64,iVBORw0KGgo=' },
  ])
  assert.equal(request.body.aspect_ratio, '16:9')
})

test('aspect_ratio 映射: 项目侧 size 字符串 → MiniMax 比例集', () => {
  const cases: Array<{ size: string; expected: string; reason: string }> = [
    { size: '1920x1080', expected: '16:9', reason: '横屏 16:9' },
    { size: '1280x720', expected: '16:9', reason: '横屏 16:9（720p）' },
    { size: '720x1280', expected: '9:16', reason: '竖屏 9:16' },
    { size: '1080x1920', expected: '9:16', reason: '竖屏 9:16（1080p）' },
    { size: '1024x1024', expected: '1:1', reason: '方形' },
    { size: '1152x864', expected: '4:3', reason: '4:3' },
    { size: '1248x832', expected: '3:2', reason: '3:2（横）' },
    { size: '832x1248', expected: '2:3', reason: '2:3（竖）' },
    { size: '864x1152', expected: '3:4', reason: '3:4' },
    { size: '1344x576', expected: '21:9', reason: '21:9 超宽' },
    { size: '16:9', expected: '16:9', reason: '前端可能直接传比例字符串' },
    { size: '', expected: '16:9', reason: '空值回落默认' },
    { size: '99999x99999', expected: '1:1', reason: '正方形仍按 1:1 识别（比例正好命中，不算异常）' },
    { size: '100x1000', expected: '16:9', reason: '极端非标准比例无法识别 → 回落默认' },
    { size: 'abc', expected: '16:9', reason: '非法 size → 回落默认' },
  ]

  for (const c of cases) {
    const request = adapter.buildGenerateRequest(config, {
      id: 1,
      prompt: 'test',
      size: c.size,
    })
    assert.equal(
      request.body.aspect_ratio,
      c.expected,
      `size="${c.size}" 期望 ${c.expected} (${c.reason})`,
    )
  }
})

test('prompt 超长 1500 字符硬拒绝', () => {
  assert.throws(
    () =>
      adapter.buildGenerateRequest(config, {
        id: 1,
        prompt: 'a'.repeat(1501),
      }),
    /1500/,
  )
})

test('模型名校验：仅 image-01 / image-01-live 合法', () => {
  assert.throws(
    () =>
      adapter.buildGenerateRequest(config, {
        id: 1,
        prompt: 'ok',
        model: 'gpt-image-2',
      }),
    /仅支持模型.*image-01,\s*image-01-live/,
  )
})

test('parseGenerateResponse: 同步 URL 模式取 data.image_urls[0]', () => {
  const parsed = adapter.parseGenerateResponse({
    id: '03ff3cd0820949eb8a410056b5f21d38',
    data: { image_urls: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'] },
    metadata: { success_count: 2, failed_count: 0 },
    base_resp: { status_code: 0, status_msg: 'success' },
  })

  assert.deepEqual(parsed, { isAsync: false, imageUrl: 'https://cdn.example.com/1.jpg' })
})

test('parseGenerateResponse: base64 模式走 generateImageThumb 落盘分支', () => {
  const parsed = adapter.parseGenerateResponse({
    id: 'x',
    data: { image_base64: ['iVBORw0KGgoAAAA='] },
    base_resp: { status_code: 0, status_msg: 'success' },
  })

  assert.deepEqual(parsed, { isAsync: false, imageUrl: undefined })
  assert.equal(adapter.extractImageBase64({
    data: { image_base64: ['iVBORw0KGgoAAAA='] },
  })?.mimeType, 'image/png')
})

test('parseGenerateResponse: 上游非零 status_code 直接抛错附码', () => {
  const cases: Array<{ code: number; msg: string; expected: RegExp }> = [
    { code: 1002, msg: '触发限流', expected: /\[1002\].*触发限流/ },
    { code: 1004, msg: '账号鉴权失败', expected: /\[1004\].*账号鉴权失败/ },
    { code: 1008, msg: '账号余额不足', expected: /\[1008\].*账号余额不足/ },
    { code: 1026, msg: '图片描述涉及敏感内容', expected: /\[1026\].*图片描述涉及敏感内容/ },
    { code: 2013, msg: '传入参数异常', expected: /\[2013\].*传入参数异常/ },
    { code: 2049, msg: '无效的api key', expected: /\[2049\].*无效的api key/ },
  ]
  for (const c of cases) {
    assert.throws(
      () =>
        adapter.parseGenerateResponse({
          data: {},
          base_resp: { status_code: c.code, status_msg: c.msg },
        }),
      c.expected,
      `status_code=${c.code}`,
    )
  }
})

test('同步接口不该被轮询；轮询方法直接抛错避免误用', () => {
  assert.throws(() => adapter.buildPollRequest(config, 'task-1'), /同步接口.*不使用轮询/)
  assert.throws(() => adapter.parsePollResponse({}), /同步接口.*不使用轮询/)
})

test('extractImageUrl 兼容顶层 / data.image_urls 两种路径', () => {
  assert.equal(
    adapter.extractImageUrl({ data: { image_urls: ['https://a/1.jpg'] } }),
    'https://a/1.jpg',
  )
  assert.equal(adapter.extractImageUrl({ data: {} }), null)
  assert.equal(adapter.extractImageUrl(null), null)
})

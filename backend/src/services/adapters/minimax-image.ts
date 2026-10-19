/**
 * MiniMax 图片生成 Adapter
 * 端点: POST /v1/image_generation （同步返回）
 * 鉴权: Authorization: Bearer <api_key>
 *
 * 同一端点同时支持两种模式（按请求体字段区分）：
 *   - 文生图(T2I)  prompt 必填，**不携带 subject_reference**
 *   - 图生图(I2I)  prompt + subject_reference[]（当前仅 character 类型，image_file 支持 URL/DataURL）
 *
 * 支持模型:
 *   - image-01       T2I + I2I（character 主体参考），支持 aspect_ratio 或 width×height
 *   - image-01-live  image-01 的增强版，额外支持 style_type 画风（漫画/元气/中世纪/水彩）
 *
 * 请求体要点:
 *   - prompt          必填，≤1500 字符
 *   - subject_reference 仅 I2I 需要；T2I 不传即可（API 默认省略则视为文生图）
 *   - aspect_ratio    与 width/height 互斥；同时设优先 aspect_ratio
 *   - response_format 'url'（24h 有效期，本适配器走 url 简化后续下载） | 'base64'
 *   - n               [1, 9]，本适配器恒为 1
 *
 * 响应: { data: { image_urls: [...] } , base_resp: { status_code, status_msg } }
 *   - status_code = 0 表示成功；其他见官方错误码（1002/1004/1008/1026/2013/2049 等）
 *
 * 注意（与视频端的差异）:
 *   - 视频端: /v2/video_generation（BaseURL: api.minimaxi.com 国际）
 *   - 图片端: /v1/image_generation（BaseURL: api.minimax.cn     国内）
 *   两者 domain 不同；通过 config.baseUrl 自动适配，不必硬编码。
 *
 * 轮询: MiniMax 图片为同步接口，正常流程不会触发。如触发则视为协议变更。
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'

const SUPPORTED_MODELS = ['image-01', 'image-01-live'] as const
const DEFAULT_MODEL = 'image-01'

const PROMPT_MAX_CHARS = 1500
const DEFAULT_ASPECT_RATIO = '16:9'

/** 官方支持的比例（21:9 仅 image-01；image-01-live 视觉宽度相同则接受） */
const VALID_ASPECT_RATIOS = new Set([
  '1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9',
])

/** 项目侧 size=WxH 字符串 → MiniMax aspect_ratio。解析失败回落到 16:9 */
function sizeToAspectRatio(size?: string | null): string {
  if (!size) return DEFAULT_ASPECT_RATIO
  const trimmed = String(size).trim()

  // 兼容直接传 aspect_ratio 字符串（前端可能存 "16:9"）
  if (VALID_ASPECT_RATIOS.has(trimmed)) return trimmed

  const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(trimmed)
  if (!m) return DEFAULT_ASPECT_RATIO
  const w = Number(m[1])
  const h = Number(m[2])
  if (!w || !h) return DEFAULT_ASPECT_RATIO

  const ratio = w / h
  // 按比例值查找最接近的官方比例，5% 容差内视为命中
  const candidates: Array<{ ratio: number; value: string }> = [
    { ratio: 1, value: '1:1' },
    { ratio: 4 / 3, value: '4:3' },
    { ratio: 3 / 2, value: '3:2' },
    { ratio: 16 / 9, value: '16:9' },
    { ratio: 21 / 9, value: '21:9' },
    { ratio: 9 / 16, value: '9:16' },
    { ratio: 2 / 3, value: '2:3' },
    { ratio: 3 / 4, value: '3:4' },
  ]
  for (const c of candidates) {
    if (Math.abs(c.ratio - ratio) / c.ratio <= 0.05) return c.value
  }
  return DEFAULT_ASPECT_RATIO
}

function parseReferenceImages(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

export class MiniMaxImageAdapter implements ImageProviderAdapter {
  provider = 'minimax'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const model = (record.model || config.model || DEFAULT_MODEL).toLowerCase()
    if (!(SUPPORTED_MODELS as readonly string[]).includes(model)) {
      throw new Error(
        `MiniMax 图片仅支持模型: ${SUPPORTED_MODELS.join(', ')},当前: ${record.model || config.model}`,
      )
    }

    const prompt = (record.prompt || '').trim()
    if (!prompt) {
      throw new Error('MiniMax 图片生成要求必须提供提示词(prompt)')
    }
    if (prompt.length > PROMPT_MAX_CHARS) {
      throw new Error(
        `提示词超长:MiniMax 上限 ${PROMPT_MAX_CHARS} 字符,当前 ${prompt.length}`,
      )
    }

    const refs = parseReferenceImages(record.referenceImages)

    const body: any = {
      model,
      prompt,
      response_format: 'url',
      n: 1,
      aspect_ratio: sizeToAspectRatio(record.size),
    }

    // 有参考图 → 转 subject_reference[]（character 是当前唯一类型）
    // image_file 支持公网 URL 或 Data URL（前端 generation.ts 已归一化为 data URL）
    if (refs.length) {
      body.subject_reference = refs.map((url) => ({
        type: 'character',
        image_file: url,
      }))
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/image_generation'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    // 1) 错误码优先判断 (0=成功)
    const baseResp = result?.base_resp
    if (baseResp && typeof baseResp === 'object' && Number(baseResp.status_code) !== 0) {
      const code = baseResp.status_code
      const msg = baseResp.status_msg || 'unknown'
      throw new Error(`MiniMax 图片生成失败 [${code}]: ${msg}`)
    }

    // 2) URL 模式（response_format: 'url'）
    const urls: string[] | undefined = result?.data?.image_urls
    if (Array.isArray(urls) && urls.length) {
      return { isAsync: false, imageUrl: String(urls[0]) }
    }

    // 3) base64 模式（response_format: 'base64'）— 走 generation.ts 的 base64 落盘分支
    const b64s: string[] | undefined = result?.data?.image_base64
    if (Array.isArray(b64s) && b64s.length) {
      return { isAsync: false, imageUrl: undefined }
    }

    // 4) 拿到 task_id 但没图，怀疑上游协议变化（MiniMax 文档示意见同步返回）
    if (result?.id) {
      throw new Error(
        `MiniMax 图片返回了任务 ID(${result.id}) 但既无 image_urls 也无 image_base64,疑似上游协议变更`,
      )
    }

    throw new Error('MiniMax 图片响应中既无 image_urls 也无 image_base64')
  }

  buildPollRequest(_config: AIConfig, _taskId: string): ProviderRequest {
    // MiniMax 图片为同步接口,正常流程不会调用；保留实现以满足接口契约
    throw new Error('MiniMax 图片生成为同步接口,不使用轮询。如需异步请改用其他厂商')
  }

  parsePollResponse(_result: any): ImagePollResponse {
    throw new Error('MiniMax 图片生成为同步接口,不使用轮询')
  }

  extractImageUrl(result: any): string | null {
    const urls = result?.data?.image_urls
    if (Array.isArray(urls) && urls.length) return String(urls[0])
    return null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64s = result?.data?.image_base64
    if (Array.isArray(b64s) && b64s.length) {
      return { data: String(b64s[0]), mimeType: 'image/png' }
    }
    return null
  }
}

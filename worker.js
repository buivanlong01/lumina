/* Lumina API for Cloudflare Workers — ES module, no npm packages.
 * Paste this WHOLE file into the Worker editor, replacing Hello World.
 * Settings > Variables and Secrets: add FAL_KEY and STUDIO_ACCESS_TOKEN
 * as Secret values. Use a random access token of at least 32 characters.
 * Never paste real keys into this source code or send them in chat.
 */
const MODELS = {
  veo: {
    text: 'fal-ai/veo3.1',
    image: 'fal-ai/veo3.1/image-to-video',
    durations: [4, 6, 8],
  },
  fast: {
    text: 'fal-ai/veo3.1/fast',
    image: 'fal-ai/veo3.1/fast/image-to-video',
    durations: [4, 6, 8],
  },
  kling: {
    text: 'fal-ai/kling-video/v3/pro/text-to-video',
    image: 'fal-ai/kling-video/v3/pro/image-to-video',
    durations: [5, 8, 10],
  },
};
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 1500000;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
// Best-effort local throttle only: not a global quota or a billing limit.
const submitted = [];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
function configured(env) {
  return typeof env.FAL_KEY === 'string' && !!env.FAL_KEY.trim()
    && typeof env.STUDIO_ACCESS_TOKEN === 'string'
    && env.STUDIO_ACCESS_TOKEN.length >= 32 && env.STUDIO_ACCESS_TOKEN.length <= 512;
}
async function authenticate(request, env) {
  if (!configured(env)) throw new HttpError(503,
    'Máy chủ chưa cấu hình đủ FAL_KEY và STUDIO_ACCESS_TOKEN (tối thiểu 32 ký tự).');
  const supplied = request.headers.get('x-studio-token') || '';
  if (supplied.length > 512) throw new HttpError(401, 'Mã truy cập không hợp lệ.');
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
    crypto.subtle.digest('SHA-256', encoder.encode(env.STUDIO_ACCESS_TOKEN)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  if (difference !== 0) throw new HttpError(401, 'Mã truy cập studio không đúng.');
}
async function readJson(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Yêu cầu cần có Content-Type: application/json.');
  }
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Yêu cầu quá lớn. Worker này chỉ nhận ảnh tối đa 1 MB.');
  }
  if (!request.body) throw new HttpError(400, 'Thiếu dữ liệu.');
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'Yêu cầu quá lớn. Hãy dùng ảnh nhỏ hơn 1 MB.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new HttpError(400, 'Nội dung JSON không hợp lệ.'); }
}
function inputFor(data) {
  const { model, mode, prompt, ratio, duration, resolution, audio, image } = data;
  if (!Object.hasOwn(MODELS, model) || !['text', 'image'].includes(mode)) {
    throw new HttpError(400, 'Model hoặc chế độ không hợp lệ.');
  }
  if (typeof prompt !== 'string' || prompt.trim().length < 5 || prompt.length > 2200) {
    throw new HttpError(400, 'Mô tả cần từ 5 đến 2200 ký tự, kể cả phần phong cách.');
  }
  if (!MODELS[model].durations.includes(Number(duration))
    || !['16:9', '9:16'].includes(ratio)
    || !['720p', '1080p'].includes(resolution)
    || typeof audio !== 'boolean') {
    throw new HttpError(400, 'Thời lượng, tỷ lệ, độ phân giải hoặc âm thanh không hợp lệ.');
  }
  const input = {
    prompt: prompt.trim(),
    duration: model === 'kling' ? String(duration) : `${duration}s`,
    aspect_ratio: ratio,
    generate_audio: audio,
  };
  if (model !== 'kling') input.resolution = resolution;
  if (mode === 'image') {
    if (typeof image !== 'string') throw new HttpError(400, 'Vui lòng tải ảnh lên.');
    const comma = image.indexOf(',');
    const header = image.slice(0, comma);
    const base64 = image.slice(comma + 1);
    if (!/^data:image\/(png|jpeg|webp);base64$/.test(header)
      || !base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new HttpError(400, 'Ảnh cần là PNG, JPEG hoặc WebP dạng base64 hợp lệ.');
    }
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    if (base64.length * 3 / 4 - padding > MAX_IMAGE_BYTES) {
      throw new HttpError(413, 'Bản Cloudflare này nhận ảnh tối đa 1 MB. Hãy nén ảnh rồi thử lại.');
    }
    input[model === 'kling' ? 'start_image_url' : 'image_url'] = image;
  }
  return { endpoint: MODELS[model][mode], input };
}
function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function unbase64url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  const s = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
}
async function signingKey(env) {
  return crypto.subtle.importKey('raw', encoder.encode(
    'lumina-job-v1\0' + env.STUDIO_ACCESS_TOKEN + '\0' + env.FAL_KEY
  ), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function validQueueUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'queue.fal.run'
      && !u.username && !u.password && !u.port && !u.search && !u.hash
      && /^\/fal-ai\/[A-Za-z0-9_./-]+\/requests\/[A-Za-z0-9_-]+(?:\/status)?$/.test(u.pathname);
  } catch { return false; }
}
async function makeJob(data, env) {
  const payload = base64url(encoder.encode(JSON.stringify(data)));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(payload));
  return payload + '.' + base64url(new Uint8Array(signature));
}
async function readJob(id, env) {
  try {
    if (id.length > 4096) throw new Error();
    const parts = id.split('.');
    if (parts.length !== 2) throw new Error();
    const [payload, signature] = parts;
    if (!await crypto.subtle.verify('HMAC', await signingKey(env), unbase64url(signature), encoder.encode(payload))) throw new Error();
    const job = JSON.parse(new TextDecoder().decode(unbase64url(payload)));
    if (job.v !== 1 || !Number.isFinite(job.expires) || job.expires <= Date.now()
      || job.expires > Date.now() + JOB_TTL_MS + 60000
      || !validQueueUrl(job.statusUrl) || !validQueueUrl(job.resultUrl)) throw new Error();
    return job;
  } catch { throw new HttpError(404, 'Mã tác vụ không hợp lệ hoặc đã hết hạn (24 giờ).'); }
}
async function provider(url, env, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { 'Authorization': 'Key ' + env.FAL_KEY, 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(25000),
    });
  } catch { throw new HttpError(502, 'Không kết nối được fal. Nếu đã gửi yêu cầu tạo, kiểm tra fal dashboard trước khi tạo lại để tránh tính phí hai lần.'); }
  if (!response.ok) {
    const messages = {
      401: 'Khóa FAL_KEY không hợp lệ.',
      403: 'Tài khoản fal chưa có quyền truy cập model hoặc yêu cầu bị từ chối.',
      402: 'Tài khoản fal cần kiểm tra số dư/thanh toán.',
      404: 'Model hoặc tác vụ không còn khả dụng tại nhà cung cấp.',
      422: 'Nhà cung cấp từ chối thông số, ảnh hoặc nội dung. Kiểm tra fal dashboard.',
      429: 'Nhà cung cấp đang giới hạn số yêu cầu. Vui lòng chờ.',
    };
    throw new HttpError(502, messages[response.status] || 'Lỗi nhà cung cấp fal. Kiểm tra dashboard trước khi tạo lại.');
  }
  try { return await response.json(); }
  catch { throw new HttpError(502, 'fal trả về kết quả không hợp lệ.'); }
}
async function route(request, env) {
  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && pathname === '/') {
    return json({ service: 'Lumina Cloudflare API', status: 'ok', version: '1.0', config: '/api/config' });
  }
  if (request.method === 'GET' && pathname === '/api/config') {
    return json({ configured: configured(env), protected: true, models: Object.keys(MODELS), maxImageBytes: MAX_IMAGE_BYTES });
  }
  if (request.method === 'POST' && pathname === '/api/generate') {
    await authenticate(request, env);
    // Optional emergency stop: set GENERATION_DISABLED to true in Settings.
    if (env.GENERATION_DISABLED === 'true') throw new HttpError(503, 'Quản trị viên đã tạm dừng tạo video.');
    const { endpoint, input } = inputFor(await readJson(request));
    const now = Date.now();
    while (submitted.length && now - submitted[0] >= 60000) submitted.shift();
    if (submitted.length >= 3) throw new HttpError(429, 'Tối đa 3 yêu cầu/phút trên phiên máy chủ này. Vui lòng chờ.');
    submitted.push(now);
    const queued = await provider('https://queue.fal.run/' + endpoint, env, {
      method: 'POST', body: JSON.stringify(input),
    });
    if (!validQueueUrl(queued.status_url) || !validQueueUrl(queued.response_url)) {
      throw new HttpError(502, 'fal đã nhận yêu cầu nhưng định dạng tác vụ đã đổi. Kiểm tra fal dashboard, không tạo lại ngay.');
    }
    const id = await makeJob({ v: 1, statusUrl: queued.status_url,
      resultUrl: queued.response_url, expires: now + JOB_TTL_MS }, env);
    return json({ id });
  }
  if (request.method === 'GET' && pathname.startsWith('/api/jobs/')) {
    await authenticate(request, env);
    const job = await readJob(pathname.slice('/api/jobs/'.length), env);
    const status = await provider(job.statusUrl, env);
    if (status.status === 'COMPLETED') {
      const result = await provider(job.resultUrl, env);
      const video = result.video?.url;
      if (typeof video !== 'string' || !video.startsWith('https://')) {
        throw new HttpError(502, 'Tác vụ không trả về video. Xem chi tiết ở fal dashboard.');
      }
      return json({ status: 'COMPLETED', url: video });
    }
    if (!['IN_QUEUE', 'IN_PROGRESS'].includes(status.status)) {
      throw new HttpError(502, 'Tác vụ không thể hoàn tất. Kiểm tra nội dung và fal dashboard.');
    }
    return json({ status: status.status });
  }
  throw new HttpError(404, 'Không có API này.');
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = ['https://localhost', 'capacitor://localhost'];
    if (env.ALLOWED_ORIGIN) allowed.push(env.ALLOWED_ORIGIN);
    const allowOrigin = origin && allowed.includes(origin);
    if (origin && !allowOrigin) return json({ error: 'Origin không được phép.' }, 403);
    let response;
    if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
    else {
      try { response = await route(request, env); }
      catch (error) {
        response = json({ error: error instanceof HttpError ? error.message : 'Máy chủ gặp lỗi. Kiểm tra Worker logs; không gửi lại tác vụ trả phí ngay.' }, error instanceof HttpError ? error.status : 500);
      }
    }
    if (allowOrigin) {
      response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, x-studio-token');
      response.headers.set('Vary', 'Origin');
    }
    return response;
  },
};

import 'dotenv/config';
import express from 'express';
import { fal } from '@fal-ai/client';
import { randomUUID, timingSafeEqual } from 'node:crypto';
const app = express();
app.use(express.json({limit:'12mb'}));
const models = {
 'veo': {text:'fal-ai/veo3.1',image:'fal-ai/veo3.1/image-to-video'},
 'fast': {text:'fal-ai/veo3.1/fast',image:'fal-ai/veo3.1/fast/image-to-video'},
 'kling': {text:'fal-ai/kling-video/v3/pro/text-to-video',image:'fal-ai/kling-video/v3/pro/image-to-video'}
};
const jobs = new Map(); const rates = new Map();
// Paid generation requires a server-configured access token, even in the preview.
function authorized(req) { const token = process.env.STUDIO_ACCESS_TOKEN; const given = req.headers['x-studio-token']; if(!token || typeof given !== 'string') return false; const a=Buffer.from(token),b=Buffer.from(given);return a.length===b.length && timingSafeEqual(a,b); }
app.get('/api/config', (req,res)=>res.json({configured:!!process.env.FAL_KEY,protected:true,models:Object.keys(models)}));
app.post('/api/generate',async(req,res)=>{
 try {
  if(!process.env.FAL_KEY) return res.status(503).json({error:'Chưa cấu hình FAL_KEY trên máy chủ. Bạn có thể trải nghiệm chế độ demo.'});
  if(!authorized(req)) return res.status(401).json({error:'Nhập mã truy cập studio trong phần Kết nối API để tạo video thật.'});
  const now=Date.now(),id=req.ip; const recent=(rates.get(id)||[]).filter(t=>now-t<60000); if(recent.length>=3)return res.status(429).json({error:'Tối đa 3 yêu cầu/phút. Vui lòng thử lại sau.'});rates.set(id,[...recent,now]);
  const {model,prompt,mode,duration,ratio,resolution,audio,image}=req.body;
  if(!models[model] || !['text','image'].includes(mode) || typeof prompt!=='string' || prompt.trim().length<5 || prompt.length>2000) return res.status(400).json({error:'Model hoặc mô tả không hợp lệ (5–2000 ký tự).'});
  const allowedDurations=model==='kling'?[5,8,10]:[4,6,8];
  if(!allowedDurations.includes(Number(duration)) || !['16:9','9:16'].includes(ratio) || !['720p','1080p'].includes(resolution))return res.status(400).json({error:'Cấu hình video không hợp lệ.'});
  if(mode==='image' && (typeof image!=='string'||!/^data:image\/(png|jpeg|webp);base64,/.test(image)))return res.status(400).json({error:'Vui lòng tải ảnh PNG, JPEG hoặc WebP.'});
  const endpoint=models[model][mode];
  const input={prompt:prompt.trim(),duration:model==='kling'?String(duration):`${duration}s`,aspect_ratio:ratio,generate_audio:!!audio};
  if(model!=='kling') input.resolution=resolution;
  if(mode==='image')input[model==='kling'?'start_image_url':'image_url']=image;
  const result=await fal.queue.submit(endpoint,{input});const jobId=randomUUID();
  jobs.set(jobId,{endpoint,requestId:result.request_id,created:now});
  res.json({id:jobId});
 }catch(e){console.error(e);res.status(502).json({error:'Nhà cung cấp từ chối yêu cầu. Kiểm tra số dư, quyền truy cập model và cấu hình API.'});}
});
app.get('/api/jobs/:id',async(req,res)=>{
 if(!authorized(req))return res.status(401).json({error:'Mã truy cập không hợp lệ.'});
 const job=jobs.get(req.params.id);if(!job)return res.status(404).json({error:'Không tìm thấy tác vụ.'});
 try {const status=await fal.queue.status(job.endpoint,{requestId:job.requestId,logs:false});
 if(status.status==='COMPLETED'){const result=await fal.queue.result(job.endpoint,{requestId:job.requestId});return res.json({status:'COMPLETED',url:result.data.video.url});}
 res.json({status:status.status});
 }catch(e){res.status(502).json({error:'Không thể đọc kết quả từ nhà cung cấp.'});}
});
setInterval(()=>{for(const [id,j] of jobs)if(Date.now()-j.created>86400000)jobs.delete(id);for(const [id,t]of rates)if(t.every(x=>Date.now()-x>60000))rates.delete(id);},60000).unref();
if(process.env.NODE_ENV==='production'){app.use(express.static('dist'));app.get('/{*path}',(req,res)=>res.sendFile(process.cwd()+'/dist/index.html'));}
else {const {createServer}=await import('vite');const vite=await createServer({server:{middlewareMode:true,allowedHosts:true},appType:'spa'});app.use(vite.middlewares);}
fal_sk_6aeee6fc9f3b4e7ab7ac8e86b75a8641:cc83bb6c4c93365a90c76ae5d7277428
00'));

import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {hash, save, readJSON, safeURL} from './core.mjs';

export async function loadKey() {
  if(process.env.FAL_KEY?.trim()) return process.env.FAL_KEY.trim();
  if(process.env.PODCAST_FAL_ENV_FILE) {
    const text=await readFile(process.env.PODCAST_FAL_ENV_FILE,'utf8');
    const line=text.split(/\r?\n/).find(s=>/^\s*(?:export\s+)?FAL_KEY\s*=/.test(s));
    let value=line?.replace(/^\s*(?:export\s+)?FAL_KEY\s*=\s*/,'').trim();
    if(value?.startsWith('"') || value?.startsWith("'")) value=value.slice(1,value.lastIndexOf(value[0]));
    else value=value?.replace(/\s+#.*$/,'').trim();
    if(value) return value;
  }
  throw new Error('FAL_KEY is not configured. Set it in the environment or use PODCAST_FAL_ENV_FILE.');
}

export async function download(url, file, maxBytes=512*1024*1024) {
  if(!safeURL(url)) throw new Error('Media needs a valid HTTP(S) URL.');
  const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
  if(!response.ok) throw new Error(`Media download failed (HTTP ${response.status}).`);
  if(Number(response.headers.get('content-length'))>maxBytes) throw new Error('Media exceeds the 512 MB download limit.');
  const chunks=[];let total=0;
  for await(const chunk of response.body) {
    total+=chunk.length;
    if(total>maxBytes) {await response.body.cancel().catch(()=>{});throw new Error('Media exceeds the download size limit.');}
    chunks.push(chunk);
  }
  if(!total) throw new Error('Media download was empty.');
  await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file+'.partial',Buffer.concat(chunks));
  await rename(file+'.partial',file);
}

export class FalJobs {
  constructor(dir,key,{fetchImpl=fetch,pollMs=3500,timeoutMs=15*60*1000}={}) {
    this.dir=dir;this.key=key;this.fetch=fetchImpl;this.pollMs=pollMs;this.timeoutMs=timeoutMs;
  }
  async api(url,init={}) {
    // Never forward the key to a response-controlled host outside fal's queue.
    const parsed=new URL(url);
    if(parsed.protocol!=='https:' || parsed.hostname!=='queue.fal.run') throw new Error('Unexpected provider queue URL.');
    const response=await this.fetch(url,{...init,headers:{Authorization:`Key ${this.key}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(120000)});
    if(!response.ok) throw new Error(`fal request failed (HTTP ${response.status}). Request records were retained for inspection.`);
    return response.json();
  }
  async run(label,endpoint,input) {
    const fingerprint=hash({endpoint,input}),file=path.join(this.dir,`${label}-${fingerprint.slice(0,16)}.json`);
    let record=await readJSON(file);
    if(record?.state==='complete') return record.data;
    record ||= {endpoint,fingerprint,state:'prepared',created_at:new Date().toISOString()};
    if(!record.request_id) {
      if(['submitting','submission_unknown'].includes(record.state)) throw new Error('An earlier fal submission has an unknown outcome. Check fal request history before a new submission.');
      record.state='submitting'; await save(file,record);
      try {
        const job=await this.api(`https://queue.fal.run/${endpoint}`,{method:'POST',body:JSON.stringify(input)});
        if(!job.request_id || !job.status_url || !job.response_url) throw new Error('Provider returned no resumable request record.');
        Object.assign(record,{request_id:job.request_id,status_url:job.status_url,response_url:job.response_url,state:'queued'});
        await save(file,record);
        console.log(`${label}: submitted (${job.request_id})`);
      } catch(e) {
        if(!record.request_id) record.state='submission_unknown';
        await save(file,record);throw e;
      }
    } else console.log(`${label}: resuming saved request`);
    const deadline=Date.now()+this.timeoutMs;let last='';
    while(Date.now()<deadline) {
      const status=await this.api(record.status_url);
      if(status.status!==last) {last=status.status;console.log(`${label}: ${last}`);}
      if(status.status==='COMPLETED') {
        const data=await this.api(record.response_url);
        Object.assign(record,{data,state:'complete',completed_at:new Date().toISOString()});await save(file,record);return data;
      }
      if(!['IN_QUEUE','IN_PROGRESS'].includes(status.status)) throw new Error('Unexpected provider state. The request ID was saved; rerun to resume.');
      await new Promise(resolve=>setTimeout(resolve,this.pollMs));
    }
    throw new Error('Provider polling timed out. Rerun the same command to resume the existing request.');
  }
  async upload(file) {
    const bytes=await readFile(file), id=hash(bytes), manifest=path.join(this.dir,`upload-${id.slice(0,16)}.json`);
    const existing=await readJSON(manifest);
    if(existing?.url) return existing.url;
    let require=createRequire(import.meta.url);
    if(process.env.PODCAST_DEPENDENCY_ROOT) require=createRequire(path.join(process.env.PODCAST_DEPENDENCY_ROOT,'package.json'));
    let fal;
    try {({fal}=require('@fal-ai/client'));} catch {throw new Error('Run npm install in the skill folder to enable media uploads.');}
    fal.config({credentials:this.key});
    const url=await fal.storage.upload(new File([bytes],path.basename(file),{type:'audio/mpeg'}));
    await save(manifest,{url,sha256:id});return url;
  }
}

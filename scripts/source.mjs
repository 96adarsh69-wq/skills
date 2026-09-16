import {readFile,stat,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {save,readJSON,normalizeTranscript,safeURL,cleanText,hash} from './core.mjs';
import {download} from './fal.mjs';

const exec=promisify(execFile);
const transcriptExtensions=new Set(['.txt','.srt','.vtt','.json']);
const audioPattern=/\.(?:mp3|m4a|wav|ogg|aac|flac|mp4|webm)(?:[?#]|$)/i;
export async function mediaDuration(file) {
  try {
    const {stdout}=await exec('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file],{timeout:30000});
    const seconds=Number(stdout.trim());return seconds>0?seconds:null;
  } catch{return null;}
}
async function transcriptFile(file) {return normalizeTranscript(await readFile(file,'utf8'),path.extname(file).slice(1).toLowerCase());}
async function youtube(input,cache) {
  const url=new URL(input);
  if(url.pathname==='/playlist' || url.searchParams.has('list') && !url.searchParams.has('v') && url.hostname!=='youtu.be') throw new Error('Provide one episode URL, not a playlist.');
  const bin=process.env.PODCAST_YTDLP || 'yt-dlp';
  try {
    await exec(bin,['--ignore-config','--no-playlist','--skip-download','--write-subs','--write-auto-subs','--sub-langs','en,en.*','--sub-format','vtt','--write-info-json','--no-warnings','-o',path.join(cache,'episode.%(ext)s'),input],{timeout:120000,maxBuffer:2*1024*1024});
  } catch(e) {
    if(e.code==='ENOENT') throw new Error('YouTube links require yt-dlp. Install it or provide the episode audio/transcript.');
    throw new Error('YouTube captions could not be accessed. Provide an accessible episode audio file or transcript.');
  }
  const files=await readdir(cache),metadata=await readJSON(path.join(cache,'episode.info.json'));
  const captions=files.filter(f=>f.endsWith('.vtt')).sort();
  if(captions.length) return {title:metadata?.title,segments:await transcriptFile(path.join(cache,captions[0]))};
  try {
    await exec(bin,['--ignore-config','--no-playlist','-f','bestaudio/best','--max-filesize','512M','--no-warnings','-o',path.join(cache,'episode.%(ext)s'),input],{timeout:300000,maxBuffer:2*1024*1024});
  } catch {throw new Error('Episode audio could not be downloaded. Upload the recording or supply its transcript.');}
  const audio=(await readdir(cache)).find(f=>audioPattern.test(f));
  if(!audio) throw new Error('No playable episode audio was downloaded.');
  return {title:metadata?.title,file:path.join(cache,audio)};
}
export function pageMedia(html,base) {
  const found=new Set();
  const pattern=/(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  for(const match of html.matchAll(pattern)) {
    const candidate=match[1].replace(/&amp;/g,'&');
    if(audioPattern.test(candidate)) {try {const url=new URL(candidate,base);if(safeURL(url.href))found.add(url.href);}catch{}}
  }
  const all=[...found];
  // Prefer audio over promotional video assets when the episode page has both.
  const audio=all.filter(u=>!(/\.(?:mp4|webm)(?:[?#]|$)/i.test(u)));
  const choices=audio.length?audio:all;
  if(choices.length!==1) throw new Error(choices.length?'This page links to multiple recordings. Provide the specific episode media URL.':'No directly accessible episode audio was found. Provide an audio file or transcript.');
  return choices[0];
}
export function pageDescription(html) {
  for(const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs=Object.fromEntries([...match[0].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(m=>[m[1].toLowerCase(),m[3]]));
    if(['description','og:description'].includes(attrs.name || attrs.property) && attrs.content) return cleanText(attrs.content).slice(0,1600);
  }
  return null;
}
export async function resolveSource(options,out,jobs) {
  const cache=path.join(out,'.source'),saved=await readJSON(path.join(out,'transcript.json'));
  if(saved) return saved;
  const source={url:safeURL(options.sourceUrl || options.input),title:options.title || 'Podcast episode',media_url:null};
  let segments,media;
  if(options.transcript) segments=await transcriptFile(path.resolve(options.transcript));
  else if(safeURL(options.input)) {
    const url=new URL(options.input);
    if(/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname)) {
      const result=await youtube(options.input,cache);
      segments=result.segments;media=result.file;source.title=options.title || result.title || source.title;
    } else if(audioPattern.test(url.href)) source.media_url=url.href;
    else if(transcriptExtensions.has(path.extname(url.pathname).toLowerCase())) {
      const dest=path.join(cache,'episode'+path.extname(url.pathname));await download(url.href,dest,20*1024*1024);segments=await transcriptFile(dest);
    } else {
      const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
      if(!response.ok) throw new Error(`Episode page could not be read (HTTP ${response.status}).`);
      const html=await response.text();
      if(html.length>10*1024*1024) throw new Error('Episode page is too large. Supply the direct media URL.');
      source.title=options.title || cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || source.title);
      source.description=pageDescription(html);
      source.media_url=pageMedia(html,response.url);
    }
    if(source.media_url) {
      media=path.join(cache,'episode'+(path.extname(new URL(source.media_url).pathname) || '.mp3'));
      try{await stat(media);}catch{await download(source.media_url,media);}
    }
  } else {
    const file=path.resolve(options.input),info=await stat(file);
    if(!info.isFile()) throw new Error('Input must be one media or transcript file.');
    if(transcriptExtensions.has(path.extname(file).toLowerCase())) segments=await transcriptFile(file);
    else media=file;
    source.title=options.title || path.basename(file,path.extname(file));
  }
  if(!segments) {
    const duration=await mediaDuration(media);
    if(!duration) throw new Error('Could not inspect episode audio. Install FFmpeg/ffprobe or provide a transcript.');
    if(duration>options.maxMinutes*60) throw new Error(`Episode exceeds the ${options.maxMinutes}-minute limit. Increase --max-minutes deliberately or choose a shorter source.`);
    source.duration_seconds=duration;
    const normalized=path.join(cache,'transcription.mp3');
    const normalizedRecord=path.join(cache,'normalized.json');
    const contentHash=hash(await readFile(media)),old=await readJSON(normalizedRecord);
    if(old?.content_hash!==contentHash) {
      try {
        await exec('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',media,'-vn','-ac','1','-ar','16000','-b:a','48k',normalized],{timeout:300000});
      } catch {throw new Error('Audio conversion failed. Check that FFmpeg is available and the upload is playable.');}
      await save(normalizedRecord,{content_hash:contentHash});
    }
    console.log(`Source: ${(duration/60).toFixed(1)} minutes; transcribing through fal`);
    const audio_url=await jobs.upload(normalized);
    const response=await jobs.run('transcription','fal-ai/whisper',{audio_url,task:'transcribe',chunk_level:'segment',batch_size:64});
    segments=normalizeTranscript(response,'json');
    if(segments.some(s=>s.start!==null && s.start>duration+3 || s.end!==null && s.end>duration+3)) throw new Error('Transcription timestamps exceed the source duration.');
  }
  source.timed=segments.some(s=>s.start!==null);
  const data={source,segments};await save(path.join(out,'transcript.json'),data);return data;
}

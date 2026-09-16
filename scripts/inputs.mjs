import path from 'node:path';
import {readFile,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {Readability} from '@mozilla/readability';
import {resolveSource} from './source.mjs';
import {normalizeTranscript,readJSON,save,safeURL,hash} from './core.mjs';
import {download} from './fal.mjs';

const media=/\.(mp3|m4a|wav|ogg|aac|flac|mp4|webm)(?:[?#]|$)/i;
const tidy=s=>String(s).replace(/\u00a0/g,' ').replace(/[\t ]+/g,' ').trim();
export function articleText(html,url) {
  const dom=new JSDOM(html,{url}); // Source scripts and remote resources stay disabled.
  try {
    const doc=dom.window.document;
    if([...doc.querySelectorAll('script[type="application/ld+json"]')].some(e=>/"isAccessibleForFree"\s*:\s*(?:false|"false")/i.test(e.textContent))) throw new Error('This page declares restricted content. Supply an authorized full-text export.');
    const a=new Readability(doc,{charThreshold:300,maxElemsToParse:60000}).parse();
    if(!a || a.textContent.trim().length<300) throw new Error('No substantial article body found. Supply a full-text export or document.');
    const body=new JSDOM(a.content).window;
    const blocks=[...body.document.querySelectorAll('h1,h2,h3,h4,p,li,pre,td,th')].filter(e=>!e.parentElement.closest('li,pre,td,th')).map(e=>tidy(e.textContent)).filter(Boolean);
    const text=blocks.join('\n\n') || tidy(a.textContent);
    body.close();
    if(text.length<300) throw new Error('Article extraction was too short to trust. Supply a full-text export.');
    return {title:a.title,description:a.excerpt,author:a.byline,text};
  } finally {dom.window.close();}
}
export async function pdfText(file) {
  const {getDocument,OPS}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf=await getDocument({data:new Uint8Array(await readFile(file)),isEvalSupported:false,useSystemFonts:true,verbosity:0}).promise;
  const segments=[],emptyPages=[];
  try {
    if(pdf.numPages>250) throw new Error('PDF exceeds 250 pages. Supply selected pages or split the document.');
    for(let page=1;page<=pdf.numPages;page++) {
      const p=await pdf.getPage(page),content=await p.getTextContent();
      const text=content.items.map(i=>i.str+(i.hasEOL?'\n':' ')).join('').trim();
      if(!text) {
        const ops=await p.getOperatorList();
        if(ops.fnArray.some(n=>[OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject].includes(n))) throw new Error(`PDF page ${page} needs OCR. Supply a searchable PDF or page-labelled OCR text; no pages were silently skipped.`);
        emptyPages.push(page);continue;
      }
      // Covers and section dividers can legitimately contain only a short title.
      const pageSegments=text.length<40?[{text,start:null,end:null}]:normalizeTranscript(text);
      segments.push(...pageSegments.map(s=>({...s,page})));
    }
    if(!segments.length) throw new Error('PDF has no extractable text. OCR is required.');
    return {segments,pages:pdf.numPages,emptyPages};
  } finally {await pdf.destroy();}
}
async function fetchSmall(url) {
  const r=await fetch(url,{signal:AbortSignal.timeout(45000)});
  if(!r.ok) throw new Error(`Source could not be read (HTTP ${r.status}).`);
  const chunks=[];let bytes=0;
  for await(const chunk of r.body){bytes+=chunk.length;if(bytes>12*1024*1024)throw new Error('Web page exceeds the extraction limit. Supply a document.');chunks.push(chunk);}
  return {body:Buffer.concat(chunks),type:r.headers.get('content-type')||'',url:r.url};
}
export async function extractInput(entry,cache,out,jobs,maxMinutes=180) {
  await mkdir(cache,{recursive:true});
  const url=safeURL(entry.input),ext=path.extname(url?new URL(url).pathname:entry.input).toLowerCase();
  const base={url:safeURL(entry.source_url)||url,title:entry.title||'',kind:entry.kind||'auto'};
  const podcast=async()=>{await mkdir(path.join(cache,'.source'),{recursive:true});return resolveSource({input:entry.input,transcript:entry.transcript,title:entry.title,sourceUrl:entry.source_url,maxMinutes},cache,jobs);};
  if(entry.transcript || entry.kind==='podcast' || (url&&/(^|\.)youtu(?:be\.com|\.be)$/.test(new URL(url).hostname)) || media.test(entry.input)) {
    const r=await podcast();return {source:{...r.source,kind:'podcast'},segments:r.segments};
  }
  let file=entry.input,html;
  if(url) {
    if(['.pdf','.docx','.txt','.md','.vtt','.srt','.json'].includes(ext)) {
      file=path.join(cache,'input'+ext);await download(url,file,60*1024*1024);
    } else {
      const result=await fetchSmall(url);
      base.url=result.url;
      if(result.type.includes('application/pdf') || result.body.subarray(0,5).toString()==='%PDF-') {
        file=path.join(cache,'input.pdf');await writeFile(file,result.body);
      } else {
        html=result.body.toString('utf8');
        if(entry.kind!=='article' && /<(?:audio|source)\b[^>]*(?:src|type)=/i.test(html)) {
          const r=await podcast();return {source:{...r.source,kind:'podcast'},segments:r.segments};
        }
      }
    }
  }
  const fileExt=path.extname(file).toLowerCase();
  if(html!==undefined || ['.html','.htm'].includes(fileExt)) {
    const a=articleText(html??await readFile(file,'utf8'),base.url||'https://local.invalid/');
    return {source:{...base,title:base.title||a.title,description:a.description,author:a.author,kind:'article',timed:false},segments:normalizeTranscript(a.text)};
  }
  if(fileExt==='.pdf') {
    const r=await pdfText(file);
    let local_href;
    if(!base.url){local_href=`sources/${path.basename(cache)}.pdf`;await mkdir(path.join(out,'sources'),{recursive:true});await copyFile(file,path.join(out,local_href));}
    return {source:{...base,title:base.title||path.basename(file),kind:'pdf',timed:false,pages:r.pages,empty_pages:r.emptyPages,local_href,note:'Text extracted page by page. Embedded figures and image-only information are not interpreted.'},segments:r.segments};
  }
  if(fileExt==='.docx') {
    const {default:mammoth}=await import('mammoth');
    const r=await mammoth.extractRawText({path:file});
    return {source:{...base,title:base.title||path.basename(file),kind:'document',timed:false},segments:normalizeTranscript(r.value)};
  }
  if(['.txt','.md','.srt','.vtt','.json'].includes(fileExt)) {
    return {source:{...base,title:base.title||path.basename(file),kind:['.srt','.vtt'].includes(fileExt)?'transcript':'document'},segments:normalizeTranscript(await readFile(file,'utf8'),fileExt==='.md'?'txt':fileExt.slice(1))};
  }
  throw new Error('Unsupported input. Use an article link, PDF, DOCX, text/Markdown, transcript, or audio/video file.');
}
export async function collectInputs(entries,out,jobs,{maxMinutes=180,allowPartial=false}={}) {
  const old=await readJSON(path.join(out,'transcript.json'));if(old)return old;
  if(!entries.length || entries.length>12)throw new Error('Provide 1–12 sources per brief.');
  const sources=[],segments=[],failures=[],seen=new Set();
  for(const [i,entry] of entries.entries()) {
    const id=`src${String(i+1).padStart(2,'0')}`;
    if(!entry || typeof entry.input!=='string')throw new Error('Each input needs an input URL or file path.');
    const identity=hash({input:entry.input,transcript:entry.transcript||null,kind:entry.kind||'auto'});
    if(seen.has(identity))continue;seen.add(identity);
    const cache=path.join(out,'.source',id);
    try {
      const r=await extractInput(entry,cache,out,jobs,maxMinutes);
      const own=r.segments.map((s,k)=>({...s,id:`${id}-s${String(k+1).padStart(5,'0')}`,source_id:id}));
      if(own.reduce((n,s)=>n+s.text.length,0)>1500000)throw new Error('Source exceeds 1.5 million characters. Provide a selected excerpt.');
      sources.push({...r.source,id,timed:own.some(s=>s.start!==null),segments:own.length,characters:own.reduce((n,s)=>n+s.text.length,0),status:'included'});segments.push(...own);
    } catch(e){failures.push({id,title:entry.title||path.basename(entry.input),url:safeURL(entry.input),status:'failed',reason:String(e.message).replace(/https?:\/\/\S+/g,'[url]').slice(0,350)});}
  }
  await save(path.join(out,'ingestion.json'),{sources,failures});
  if(failures.length&&!allowPartial)throw new Error(`${failures.length} source(s) could not be read. See ingestion.json. Resolve them or explicitly use --allow-partial; no combined brief was generated.`);
  if(!sources.length)throw new Error('No sources could be read. See ingestion.json.');
  const data={source:{title:'Listening brief',sources,failures,timed:sources.some(s=>s.timed)},segments};
  await save(path.join(out,'transcript.json'),data);return data;
}

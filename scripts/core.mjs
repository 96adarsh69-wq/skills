import {createHash} from 'node:crypto';
import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import path from 'node:path';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export async function save(file, value) {
  await mkdir(path.dirname(file), {recursive:true});
  await writeFile(file + '.partial', typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n');
  await rename(file + '.partial', file);
}
export async function readJSON(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export const escapeHTML = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function cleanText(s) {
  return String(s).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}
export function time(s) {
  if (s === null || s === undefined || s === '') return null;
  if (typeof s === 'number') return Number.isFinite(s) && s >= 0 ? s : null;
  const parts = s.trim().replace(',', '.').split(':');
  if (!parts.every(p => /^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((a, b) => a * 60 + Number(b), 0);
}
export function stamp(seconds) {
  if (!Number.isFinite(seconds)) return 'Time unavailable';
  const s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return `${h ? h + ':' + String(m).padStart(2,'0') : m}:${String(s % 60).padStart(2,'0')}`;
}
export function normalizeTranscript(raw, format='txt') {
  let rows;
  if (format === 'json') {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    rows = Array.isArray(data) ? data : data.segments || data.chunks;
    if (!rows && data.text) return normalizeTranscript(data.text);
    if (!Array.isArray(rows)) throw new Error('Transcript JSON needs segments, chunks, or text.');
    rows = rows.map(s => ({text:s.text, start:time(s.start ?? s.timestamp?.[0]), end:time(s.end ?? s.timestamp?.[1])}));
  } else if (['vtt','srt'].includes(format)) {
    rows = [];
    const lines = String(raw).replace(/\r/g,'').split('\n');
    for (let i=0; i<lines.length; i++) {
      const m=lines[i].match(/(\d{1,2}:\d{2}(?::\d{2})?[.,]\d+)\s+-->\s+(\d{1,2}:\d{2}(?::\d{2})?[.,]\d+)/);
      if (!m) continue;
      const body=[];
      while (i+1<lines.length && lines[i+1].trim() && !lines[i+1].includes('-->')) body.push(lines[++i]);
      rows.push({start:time(m[1]),end:time(m[2]),text:body.join(' ')});
    }
  } else {
    // Keep paragraphs manageable without assigning synthetic timecodes.
    rows = String(raw).split(/\n\s*\n/).flatMap(p => {
      const words=p.trim().split(/\s+/), chunks=[];
      for(let i=0;i<words.length;i+=120) chunks.push({text:words.slice(i,i+120).join(' '),start:null,end:null});
      return chunks;
    });
  }
  const segments=[];
  let previousRaw=null;
  for (const row of rows) {
    let text=cleanText(row.text || '');
    if (!text) continue;
    const original=text;
    if (row.start!==null && row.end!==null && row.end<row.start) {
      // Small ASR boundary errors: discard the invalid end, not the utterance.
      if(row.start-row.end<=0.25) {row.end=null;row.timing_note='Invalid provider end time omitted.';}
      else throw new Error('Transcript has a reversed timestamp.');
    }
    const prev=segments.at(-1);
    if (prev && prev.start!==null && row.start!==null && row.start<prev.start) row.timing_note='Overlapping provider segments; transcript order preserved.';
    // Rolling captions often repeat a suffix. Only deduplicate overlapping cues.
    if (previousRaw && row.start!==null && previousRaw.end!==null && row.start<previousRaw.end) {
      const a=previousRaw.text.split(/\s+/), b=text.split(/\s+/);
      for(let n=Math.min(a.length,b.length);n>0;n--) {
        if(a.slice(-n).join(' ')===b.slice(0,n).join(' ')) { text=b.slice(n).join(' '); break; }
      }
    }
    previousRaw={...row,text:original};
    if (text) segments.push({id:`s${String(segments.length+1).padStart(5,'0')}`,start:row.start??null,end:row.end??null,text,...(row.timing_note?{timing_note:row.timing_note}:{})});
  }
  if (!segments.length || segments.reduce((n,s)=>n+s.text.length,0)<40) throw new Error('No usable episode transcript was found.');
  return segments;
}
export function batches(segments, limit=26000) {
  const result=[]; let group=[], length=0;
  for(const segment of segments) {
    const n=JSON.stringify(segment).length;
    if (group.length && length+n>limit) {result.push(group); group=[]; length=0;}
    group.push(segment); length+=n;
  }
  if(group.length) result.push(group);
  return result;
}
export function parseModelJSON(data) {
  if(data.partial || data.error || typeof data.output !== 'string') throw new Error('Text model returned an incomplete or failed response. Saved output can be inspected in .jobs.');
  const text=data.output.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
  try {return JSON.parse(text);} catch {throw new Error('Text model did not return valid JSON. Its response is saved; no automatic paid retry was made.');}
}
export function validateEvidence(item, ids) {
  if(!item || typeof item.text!=='string' || !item.text.trim()) throw new Error('A summary item has no text.');
  if(!Array.isArray(item.segment_ids) || !item.segment_ids.length || item.segment_ids.some(id=>!ids.has(id))) throw new Error('Summary contains a missing or invalid source reference.');
}
export function validateSummary(summary, segments) {
  const ids=new Set(segments.map(s=>s.id));
  if(typeof summary.title!=='string' || !summary.title.trim()) throw new Error('Summary has no title.');
  if(!Array.isArray(summary.takeaways) || summary.takeaways.length<3 || summary.takeaways.length>12) throw new Error('Expected 3–12 summary points.');
  if(!Array.isArray(summary.narration) || !summary.narration.length) throw new Error('Summary has no narration.');
  for(const item of [summary.overview,...summary.takeaways,...summary.narration]) validateEvidence(item,ids);
  if(summary.mind_map!==undefined) {
    const map=summary.mind_map;
    if(!map || typeof map.title!=='string' || !map.title.trim() || !Array.isArray(map.topics) || map.topics.length<2 || map.topics.length>6) throw new Error('Mind map needs a title and 2–6 topics.');
    const topicIds=new Set();
    for(const topic of map.topics) {
      if(typeof topic.id!=='string' || !/^[a-z][a-z0-9-]{0,49}$/.test(topic.id) || topicIds.has(topic.id)) throw new Error('Mind map topic IDs must be unique lowercase identifiers.');
      topicIds.add(topic.id);
      if(typeof topic.title!=='string' || !topic.title.trim()) throw new Error('Mind map topic has no title.');
      validateEvidence(topic,ids);
      if(!Array.isArray(topic.points) || topic.points.length<1 || topic.points.length>4) throw new Error('Mind map topics need 1–4 supported subpoints.');
      for(const point of topic.points) validateEvidence(point,ids);
    }
    for(const takeaway of summary.takeaways) {
      if(!topicIds.has(takeaway.topic_id)) throw new Error('Takeaway links to a missing mind map topic.');
      if(typeof takeaway.sentence!=='string' || !takeaway.sentence.trim()) throw new Error('Visual takeaways need a complete summary sentence.');
    }
  }
  const sourceIds=new Set(segments.map(s=>s.source_id).filter(Boolean));
  if(sourceIds.size>1) {
    for(const [kind,items] of [['written summary',summary.takeaways],['narration',summary.narration]]) {
      const refs=new Set(items.flatMap(s=>s.segment_ids));
      const covered=new Set(segments.filter(s=>refs.has(s.id)).map(s=>s.source_id));
      if([...sourceIds].some(id=>!covered.has(id)))throw new Error(`The ${kind} omitted an included source. Every source needs supported coverage.`);
    }
  }
  if(summary.mind_map?.links) {
    const idsTopic=new Set(summary.mind_map.topics.map(t=>t.id));
    for(const link of summary.mind_map.links){if(!idsTopic.has(link.from)||!idsTopic.has(link.to)||link.from===link.to)throw new Error('Invalid concept relationship.');validateEvidence(link,ids);}
  }
  const script=summary.narration.map(p=>p.text.trim()).join('\n\n');
  if(script.length>15000) throw new Error('Narration exceeds the brief limit (15,000 characters).');
  const wordCount=script.split(/\s+/).length;
  if(wordCount<80) throw new Error('Narration is too short to be a useful digest.');
  return {script,wordCount};
}
export function safeURL(value) {
  try {const url=new URL(value); return ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;}
  catch {return null;}
}
export function sourceLink(source, seconds=null) {
  const raw=safeURL(source.url);
  if(seconds!==null && Number.isFinite(seconds)) {
    if(raw && /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(new URL(raw).hostname)) {
      const url=new URL(raw); url.searchParams.set('t',String(Math.floor(seconds))); return url.href;
    }
    const media=safeURL(source.media_url);
    if(media) {const url=new URL(media);url.hash=`t=${Math.floor(seconds)}`;return url.href;}
  }
  return raw || safeURL(source.media_url);
}
export function sourceFor(source,segment) {return source.sources?.find(s=>s.id===segment?.source_id)||source;}
export function citation(source,segment) {
  const own=sourceFor(source,segment),base=sourceLink(own,segment?.start??null)||own.local_href||null;
  let url=base;
  if(url && segment?.page){const split=url.split('#')[0];url=split+'#page='+segment.page;}
  const label=[own.id?.replace('src','S'),segment?.page?'p. '+segment.page:segment?.start!=null?stamp(segment.start):'Source'].filter(Boolean).join(' · ');
  return {url,label,title:own.title||'Source'};
}
export async function render(out,summary,segments,source,run) {
  validateSummary(summary,segments);
  const lookup=new Map(segments.map(s=>[s.id,s]));
  const cite=item=>[...new Map(item.segment_ids.map(id=>{const s=lookup.get(id),c=citation(source,s);return [c.label,c];})).values()].map(c=>c.url?`[${c.label}](${c.url})`:c.label).join(' · ');
  const md=`# ${summary.title}\n\n${summary.overview.text}\n\n${cite(summary.overview)}\n\n## Summary\n\n${summary.takeaways.map(t=>`### ${t.sentence||t.title}\n\n${t.text}\n\n${cite(t)}`).join('\n\n')}\n\n## Sources\n\n${(source.sources||[source]).map(s=>`- ${s.id||''} **${s.title}**${s.url?` — ${s.url}`:''}${s.note?` — ${s.note}`:''}`).join('\n')}\n\n[Listen](digest.mp3) · [Narration script](narration.html) · [Visual map](mind-map.svg)\n`;
  const {renderPage,renderNarration}=await import('./page.mjs');
  const {renderMindMap}=await import('./map.mjs');
  await Promise.all([
    save(path.join(out,'summary.md'),md),
    save(path.join(out,'index.html'),await renderPage(summary,segments,source,run)),
    save(path.join(out,'narration.html'),await renderNarration(summary,segments,source,run)),
    save(path.join(out,'narration.txt'),summary.narration.map(p=>p.text).join('\n\n')+'\n'),
    save(path.join(out,'mind-map.svg'),renderMindMap(summary,{standalone:true})),
  ]);
}

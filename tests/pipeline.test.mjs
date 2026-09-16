import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {normalizeTranscript,validateSummary,validateEvidence,parseModelJSON,batches,render,sourceLink,save} from '../scripts/core.mjs';
import {FalJobs} from '../scripts/fal.mjs';
import {resolveSource,pageMedia,pageDescription} from '../scripts/source.mjs';
import {fitNarration} from '../scripts/summarize.mjs';

const text='The guest explains how a small prototype helped the team learn before they invested in a larger project.';
const segments=[{id:'s00001',start:15,end:22,text},{id:'s00002',start:85,end:92,text:'The final experiment had an uncertain result and further testing was needed.'}];
const item={text,segment_ids:['s00001']};
const summary={title:'Test episode',overview:item,takeaways:[item,item,item],narration:Array.from({length:5},()=>item)};

test('rolling captions drop overlapping repeated text but keep later repetition',()=>{
  const result=normalizeTranscript(`WEBVTT\n\n00:00.000 --> 00:03.000\nThe first experiment failed but the team learned.\n\n00:02.000 --> 00:05.000\nthe team learned. Their second experiment succeeded.\n\n00:08.000 --> 00:10.000\nTheir second experiment succeeded.\n`,'vtt');
  assert.equal(result[1].text,'Their second experiment succeeded.');
  assert.equal(result[2].text,'Their second experiment succeeded.');
  assert.equal(result[2].start,8);
});

test('plain transcripts and unknown Whisper end times do not invent zero timestamps',()=>{
  assert.ok(normalizeTranscript(text).every(s=>s.start===null && s.end===null));
  const result=normalizeTranscript({chunks:[{text,timestamp:[4,null]}]},'json');
  assert.equal(result[0].start,4);assert.equal(result[0].end,null);
  const jitter=normalizeTranscript({chunks:[{text,timestamp:[783.070,783.014]}]},'json');
  assert.equal(jitter[0].start,783.070);assert.equal(jitter[0].end,null);
  assert.ok(jitter[0].timing_note);
  assert.throws(()=>normalizeTranscript({chunks:[{text,timestamp:[20,3]}]},'json'),/reversed/);
});

test('source references must exist for every claim and narration paragraph',()=>{
  assert.ok(validateSummary(summary,segments).wordCount>80);
  assert.throws(()=>validateSummary({...summary,narration:[{text,segment_ids:['s99999']}]},segments),/invalid source/);
  assert.throws(()=>validateEvidence({text,segment_ids:[]},new Set(['s00001'])),/invalid source/);
  assert.throws(()=>parseModelJSON({output:'{}',partial:true}),/incomplete/);
});

test('long-episode batching preserves every segment exactly once',()=>{
  const input=Array.from({length:700},(_,i)=>({...segments[0],id:`s${i}`,text:text.repeat(4)}));
  const groups=batches(input,8000);
  assert.ok(groups.length>10);assert.deepEqual(groups.flat(),input);
});

test('mind maps require supported subpoints and valid takeaway-to-topic links',()=>{
  const visual={...summary,mind_map:{title:'An episode',topics:[
    {...item,id:'experiment',title:'Experiment',points:[item]},
    {...item,id:'learn',title:'Learn',points:[item]}
  ]},takeaways:summary.takeaways.map(t=>({...t,sentence:text,topic_id:'experiment'}))};
  assert.ok(validateSummary(visual,segments).wordCount>80);
  const broken=structuredClone(visual);broken.takeaways[0].topic_id='missing';
  assert.throws(()=>validateSummary(broken,segments),/missing mind map topic/);
  const unsupported=structuredClone(visual);unsupported.mind_map.topics[1].points[0].segment_ids=['unknown'];
  assert.throws(()=>validateSummary(unsupported,segments),/invalid source/);
  const duplicate=structuredClone(visual);duplicate.mind_map.topics[1].id='experiment';
  assert.throws(()=>validateSummary(duplicate,segments),/unique lowercase/);
});

test('episode pages reject ambiguous recordings and resolve relative media',()=>{
  assert.equal(pageMedia('<a href="/episode.mp3">Audio</a><audio src="/episode.mp3">','https://example.com/show'),'https://example.com/episode.mp3');
  assert.throws(()=>pageMedia('<a href="/one.mp3">1</a><a href="/two.mp3">2</a>','https://example.com'),/multiple/);
  assert.equal(pageDescription('<meta content="Guest: Anne &amp; David" name="description">'),'Guest: Anne & David');
});

test('overlong narration gets one attempt and cannot silently reach speech',async()=>{
  const long={...summary,narration:Array.from({length:20},()=>item)};let calls=0;
  const fake={run:async()=>{calls++;return {output:JSON.stringify({narration:long.narration})};}};
  await assert.rejects(fitNarration(long,segments,fake,'test',2),/over the requested word budget/);
  assert.equal(calls,1);
});

test('provided transcript skips all fal transcription calls',async()=>{
  const out=await mkdtemp(path.join(os.tmpdir(),'podcast-transcript-'));
  const file=path.join(out,'provided.txt');await save(file,text);
  const result=await resolveSource({input:'https://example.com/episode',transcript:file,title:'Supplied episode'},out,{upload(){throw new Error('unexpected upload');},run(){throw new Error('unexpected provider call');}});
  assert.equal(result.source.timed,false);assert.equal(result.segments.length,1);
});

test('HTML escapes source content and makes the source desk accessible from the header',async()=>{
  const out=await mkdtemp(path.join(os.tmpdir(),'podcast-html-'));
  const altered={...summary,title:'<script>alert(1)</script>'};
  await render(out,altered,segments,{url:'https://example.com/episode',media_url:'https://example.com/episode.mp3',timed:true},{audio_ready:false});
  const html=await readFile(path.join(out,'index.html'),'utf8');
  assert.ok(!html.includes('<script>alert(1)</script>'));assert.ok(html.includes('&lt;script&gt;'));
  const original=html.indexOf('href="#sources"');
  assert.ok(original>=0 && original<html.indexOf('id="summary"'));
  assert.equal(sourceLink({url:'javascript:alert(1)'},0),null);
  assert.equal(sourceLink({url:'https://example.com/ep',media_url:'https://example.com/a.mp3'},85),'https://example.com/a.mp3#t=85');
});

test('completed paid jobs are cached and request payload changes get separate jobs',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'podcast-jobs-'));let submissions=0;
  const fake=async(url,init)=>({ok:true,json:async()=>{
    if(init.method==='POST'){submissions++;return {request_id:`r${submissions}`,status_url:'https://queue.fal.run/test/status',response_url:'https://queue.fal.run/test/result'};}
    if(url.endsWith('status'))return {status:'COMPLETED'};
    return {output:'result'};
  }});
  const jobs=new FalJobs(dir,'test-key',{fetchImpl:fake,pollMs:0});
  await jobs.run('test','openrouter/router',{prompt:'A'});
  await jobs.run('test','openrouter/router',{prompt:'A'});assert.equal(submissions,1);
  await jobs.run('test','openrouter/router',{prompt:'B'});assert.equal(submissions,2);
  assert.ok(!(await readFile(path.join(dir,(await readdir(dir))[0]),'utf8')).includes('test-key'));
});

test('unknown submission is never retried and resumable status failures reuse request IDs',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'podcast-unknown-'));let attempts=0;
  const unknown=new FalJobs(dir,'key',{fetchImpl:async()=>{attempts++;throw new Error('network lost');}});
  await assert.rejects(unknown.run('test','openrouter/router',{prompt:'x'}),/network lost/);
  await assert.rejects(unknown.run('test','openrouter/router',{prompt:'x'}),/unknown outcome/);assert.equal(attempts,1);
  const resumeDir=await mkdtemp(path.join(os.tmpdir(),'podcast-resume-'));let posts=0,fail=true;
  const resume=new FalJobs(resumeDir,'key',{pollMs:0,fetchImpl:async(url,init)=>{
    if(init.method==='POST'){posts++;return {ok:true,json:async()=>({request_id:'saved-id',status_url:'https://queue.fal.run/a/status',response_url:'https://queue.fal.run/a/result'})};}
    if(fail)throw new Error('status offline');
    return {ok:true,json:async()=>url.endsWith('status')?{status:'COMPLETED'}:{output:'done'}};
  }});
  await assert.rejects(resume.run('test','openrouter/router',{prompt:'x'}),/status offline/);
  fail=false;await resume.run('test','openrouter/router',{prompt:'x'});assert.equal(posts,1);
});

test('provider response cannot redirect authentication to another host',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'podcast-auth-'));let contacted=false;
  const jobs=new FalJobs(dir,'secret',{fetchImpl:async()=>{contacted=true;}});
  await assert.rejects(jobs.api('https://example.com/collect'),/Unexpected provider/);
  assert.equal(contacted,false);
});

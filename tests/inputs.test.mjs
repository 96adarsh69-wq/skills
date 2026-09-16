import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {articleText,pdfText,collectInputs} from '../scripts/inputs.mjs';
import {save,citation,validateSummary,render} from '../scripts/core.mjs';
import {speechChunks} from '../scripts/summarize.mjs';

const paragraph='Participants compared two ways of organizing their work. The first grouped related tasks together. The second preserved the order in which tasks arrived. The report describes both approaches and notes that the small sample does not establish which is better.';
const never={run(){throw new Error('Extraction must not call a text model');},upload(){throw new Error('Extraction must not upload documents');}};
const temp=()=>mkdtemp(path.join(os.tmpdir(),'listening-brief-'));
function pdf(pages){
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${pages.map((_,i)=>`${4+i*2} 0 R`).join(' ')}] /Count ${pages.length} >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  pages.forEach((text,i)=>{const stream=text===null?'q 100 0 0 100 20 20 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /AHx ID FF0000> EI Q':`BT /F1 12 Tf 20 700 Td (${text.replace(/[()\\]/g,'\\$&')}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`,`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);});
  let body='%PDF-1.4\n',offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${o}\nendobj\n`;});const xref=Buffer.byteLength(body);
  body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}
test('article extraction retains the ending and excludes navigation and scripts',()=>{
  const html=`<html><head><title>Two approaches</title></head><body><nav>Navigation noise</nav><article><h1>Two approaches</h1><p>${paragraph}</p><p>${paragraph}</p><h2>Limitations</h2><p>The final section explains that longer follow-up is necessary before drawing a conclusion.</p></article><script>throw new Error('DO NOT EXECUTE');</script></body></html>`;
  const result=articleText(html,'https://example.com/article');
  assert.ok(result.text.includes('longer follow-up'));assert.ok(!result.text.includes('Navigation noise'));assert.ok(!result.text.includes('DO NOT EXECUTE'));
  assert.throws(()=>articleText('<script type="application/ld+json">{"isAccessibleForFree":false}</script>'+html,'https://example.com'),/restricted/);
});
test('PDF extraction preserves page references, and a scanned page blocks incomplete summaries',async()=>{
  const dir=await temp(),file=path.join(dir,'two-pages.pdf');await save(file,pdf([paragraph,'Final page: '+paragraph]));
  const result=await pdfText(file);assert.equal(result.pages,2);assert.deepEqual([...new Set(result.segments.map(s=>s.page))],[1,2]);assert.ok(result.segments.at(-1).text.includes('Final page'));
  const mixed=path.join(dir,'scanned.pdf');await save(mixed,pdf([paragraph,null]));
  await assert.rejects(pdfText(mixed),/page 2 needs OCR/);
});
test('mixed inputs get unique IDs and accurate PDF links; failures cannot silently disappear',async()=>{
  const dir=await temp(),txt=path.join(dir,'notes.txt'),pdfFile=path.join(dir,'paper.pdf'),bad=path.join(dir,'unsupported.bin');
  await save(txt,paragraph);await save(pdfFile,pdf([paragraph,paragraph]));await save(bad,'unreadable');
  const entries=[{input:txt},{input:pdfFile},{input:bad}];
  await assert.rejects(collectInputs(entries,dir,never),/could not be read/);
  const report=JSON.parse(await readFile(path.join(dir,'ingestion.json'),'utf8'));assert.equal(report.sources.length,2);assert.equal(report.failures.length,1);
  const result=await collectInputs(entries,dir,never,{allowPartial:true});
  assert.equal(new Set(result.segments.map(s=>s.id)).size,result.segments.length);
  assert.equal(result.source.sources.length,2);assert.equal(result.source.failures.length,1);
  const page2=result.segments.find(s=>s.page===2),c=citation(result.source,page2);
  assert.equal(c.label,'S02 · p. 2');assert.equal(c.url,'sources/src02.pdf#page=2');
  assert.equal(citation(result.source,result.segments[0]).url,null);
});
test('every source must be represented in both the written summary and the spoken script',()=>{
  const segments=[{id:'one',source_id:'src01',text:paragraph},{id:'two',source_id:'src02',text:paragraph}];
  const first={text:paragraph,segment_ids:['one']},second={text:paragraph,segment_ids:['two']};
  const summary={title:'A collection',overview:first,takeaways:[first,second,first],narration:[first,first,first]};
  assert.throws(()=>validateSummary(summary,segments),/narration omitted/);
  summary.narration.push(second);assert.ok(validateSummary(summary,segments).wordCount>80);
  summary.takeaways=[first,first,first];assert.throws(()=>validateSummary(summary,segments),/written summary omitted/);
});
test('speech chunking retains the exact script and binary audio writes remain binary',async()=>{
  const paragraphs=Array.from({length:9},(_,i)=>({text:`Paragraph ${i}. ${paragraph.repeat(4)}`}));
  const chunks=speechChunks(paragraphs);assert.ok(chunks.length>1);assert.ok(chunks.every(c=>c.length<=3800));assert.equal(chunks.join('\n\n'),paragraphs.map(p=>p.text).join('\n\n'));
  const dir=await temp(),bytes=Buffer.from([0xff,0xfb,0,0x80,0,0x42]);await save(path.join(dir,'audio.mp3'),bytes);assert.deepEqual(await readFile(path.join(dir,'audio.mp3')),bytes);
});
test('the voice script is separate from the visual summary and remains directly accessible',async()=>{
  const dir=await temp(),seg={id:'one',text:paragraph,start:null,end:null},item={text:paragraph,segment_ids:['one']};
  const unique='This sentence occurs only in the spoken narration. '+paragraph;
  const summary={title:'Two approaches',overview:item,takeaways:[item,item,item],narration:[{text:unique,segment_ids:['one']},item]};
  await render(dir,summary,[seg],{title:'Original',url:'https://example.com',timed:false},{audio_ready:false});
  const page=await readFile(path.join(dir,'index.html'),'utf8'),script=await readFile(path.join(dir,'narration.html'),'utf8');
  assert.ok(!page.includes(unique));assert.ok(page.includes('href="narration.html"'));assert.ok(script.includes(unique));assert.equal((await readFile(path.join(dir,'narration.txt'),'utf8')).trim(),summary.narration.map(p=>p.text).join('\n\n'));
});
test('DOCX extraction includes separate body paragraphs through the final section',async()=>{
  const dir=await temp();
  const result=await collectInputs([{input:new URL('./fixtures/notes.docx',import.meta.url).pathname}],dir,never);
  assert.equal(result.source.sources[0].kind,'document');
  assert.ok(result.segments[0].text.includes('pilot study'));
  assert.ok(result.segments.at(-1).text.includes('longer follow-up'));
});
test('rerendering an edited narration hides stale audio without deleting it',async()=>{
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  const dir=await temp(),seg={id:'one',text:paragraph,start:null,end:null},item={text:paragraph,segment_ids:['one']};
  await save(path.join(dir,'summary.json'),{title:'Revised',overview:item,takeaways:[item,item,item],narration:[item,item,item]});
  await save(path.join(dir,'transcript.json'),{source:{title:'Notes'},segments:[seg]});
  await save(path.join(dir,'run.json'),{audio_ready:true,narration_sha256:'old-script',audio_sha256:'old-audio'});
  const old=Buffer.from([0xff,0xfb,0,1]);await save(path.join(dir,'digest.mp3'),old);
  await promisify(execFile)(process.execPath,[new URL('../scripts/render.mjs',import.meta.url).pathname,dir]);
  assert.equal(JSON.parse(await readFile(path.join(dir,'run.json'),'utf8')).audio_ready,false);
  assert.ok(!(await readFile(path.join(dir,'index.html'),'utf8')).includes('<audio'));
  assert.deepEqual(await readFile(path.join(dir,'digest.mp3')),old);
});

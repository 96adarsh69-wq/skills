#!/usr/bin/env node
import path from 'node:path';
import {readJSON,render,validateSummary,hash,save} from './core.mjs';
import {readFile} from 'node:fs/promises';

const input=process.argv[2];
if(!input) {console.error('Usage: node scripts/render.mjs OUTPUT_FOLDER');process.exitCode=1;}
else {
  try {
    const out=path.resolve(input);
    const [summary,transcript,run]=await Promise.all(['summary.json','transcript.json','run.json'].map(f=>readJSON(path.join(out,f))));
    if(!summary || !transcript || !run) throw new Error('Folder needs summary.json, transcript.json and run.json.');
    const {script}=validateSummary(summary,transcript.segments);
    if(run.audio_ready) {
      try{run.audio_ready=run.narration_sha256===hash(script) && run.audio_sha256===hash(await readFile(path.join(out,'digest.mp3')));}
      catch{run.audio_ready=false;}
      if(!run.audio_ready){run.state='notes_only';await save(path.join(out,'run.json'),run);}
    }
    await render(out,summary,transcript.segments,transcript.source,run);
    console.log('Rendered '+path.join(out,'index.html')+' using existing notes and audio.');
  } catch(e) {console.error(e.message);process.exitCode=1;}
}

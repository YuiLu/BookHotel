import fs from 'node:fs/promises';
import path from 'node:path';

export async function privateDir(dir) { await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.chmod(dir,0o700); }
export async function atomicJson(file, data) {
  return atomicText(file,JSON.stringify(data,null,2)+'\n');
}
export async function atomicText(file, text) {
  const temp=`${file}.${process.pid}.tmp`;
  const h=await fs.open(temp,'wx',0o600);
  try {await h.writeFile(text);await h.sync();} finally {await h.close();}
  await fs.rename(temp,file);
}
export class State {
  constructor(dir,hotelCode) {this.dir=dir;this.hotelCode=hotelCode;this.file=path.join(dir,'state.json');this.lock=path.join(dir,'process.lock');}
  async acquire() {
    await privateDir(this.dir);
    try {this.handle=await fs.open(this.lock,'wx',0o600);await this.handle.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));}
    catch(e) {if(e.code==='EEXIST')throw new Error('PROCESS_LOCKED');throw e;}
  }
  async release() {if(this.handle){await this.handle.close();await fs.unlink(this.lock);this.handle=null;}}
  async read() {try{return JSON.parse(await fs.readFile(this.file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  async ensureReady() {
    const state=await this.read();
    if(state?.hotelCode&&this.hotelCode&&state.hotelCode!==this.hotelCode)throw new Error('STATE_HOTEL_MISMATCH');
    if(state && !['MONITORING','RESOLVED_NOT_BOOKED'].includes(state.status)) throw new Error('PREVIOUS_ATTEMPT_REQUIRES_REVIEW');
  }
  async write(status, details={}) {await atomicJson(this.file,{status,at:new Date().toISOString(),...details,...(this.hotelCode?{hotelCode:this.hotelCode}:{})});}
  async event(type, details={}) {
    const line=JSON.stringify({at:new Date().toISOString(),type,...details});
    console.log(line);await fs.appendFile(path.join(this.dir,'events.jsonl'),line+'\n',{mode:0o600});
  }
}

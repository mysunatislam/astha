import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createHash } from 'node:crypto';

const read=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
function luminance(hex){
 const rgb=hex.match(/[a-f0-9]{2}/gi).map(x=>parseInt(x,16)/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);
 return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
}
function contrast(a,b){const x=luminance(a),y=luminance(b);return(Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);}

test('lavender theme keeps readable text, buttons, semantic status and focus contrast',()=>{
 const source=read('tools/base.html');
 const block=/html\[data-theme="lavender"\],[\s\S]*?\{([^}]+)\}/.exec(source)?.[1];assert(block);
 const c=Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[a-f0-9]{6})/gi)].map(m=>[m[1],m[2]]));
 for(const fg of ['text','muted','faint'])for(const bg of ['bg','surface','surface-2','surface-3'])assert(contrast(c[fg],c[bg])>=4.5,`${fg} on ${bg} needs WCAG AA contrast`);
 for(const [fg,bg]of [['accent-ink','accent'],['accent-ink','accent-strong'],['companion-tone-ink','companion-tone'],['companion-tone-ink','companion-tone-strong'],['danger','danger-soft'],['warn','warn-soft'],['ok','ok-soft'],['info','surface']])assert(contrast(c[fg],c[bg])>=4.5,`${fg} on ${bg} needs readable contrast`);
 assert(contrast(c.accent,c.bg)>=3,'focus ring remains visible on the page');
 assert(contrast(c['accent-ink'],c.accent)>=3,'hero focus ring remains visible');
 for(const theme of ['clinical-yellow','monochrome','navy-cyan'])assert(source.includes(`data-theme="${theme}"`),'existing high-contrast option remains');
});

test('LUNEYRA preserves the supplied emblem and names the app without changing installed identity',()=>{
 const html=read('web/index.html'),manifest=JSON.parse(read('web/manifest.webmanifest'));
 assert.match(html,/<title>LUNEYRA — AI Vision Companion<\/title>/);
 assert.match(html,/<html[^>]+data-theme="lavender"/);
 assert.equal(manifest.short_name,'LUNEYRA');assert.equal(manifest.theme_color,'#64409a');
 for(const [name,hash] of [['astha-mulberry-apricot-v1.png','e712869f7134de9acbb1705152d46fb84576711eea27351d654370d13107f706'],['astha-mulberry-apricot-dark-v1.png','df4a48c46143e07cfef366b29950bab0930ec7ae858cfa116b61b4a0726b386f']]){
  assert.equal(createHash('sha256').update(fs.readFileSync(new URL('../web/brand/'+name,import.meta.url))).digest('hex'),hash,'supplied logo bytes are unchanged');
  assert(read('web/sw.js').includes('brand/'+name),'branding stays available offline');
 }
 const markup=html.slice(0,html.indexOf('<script'));
 assert.doesNotMatch(markup,/alt="Astha"|>Ask Astha</);
 assert.match(markup,/class="brand-wordmark" data-i18n="brand">LUNEYRA<\/span>/);
 assert.match(markup,/src="brand\/luneyra-purple-winged-v1\.png"/,'the complete updated purple wordmark is displayed');
 assert(read('web/sw.js').includes('brand/luneyra-purple-winged-v1.png'),'the updated logo is cached for offline use');
 const native=JSON.parse(read('capacitor.config.json'));
 assert.equal(native.appName,'LUNEYRA');assert.equal(native.appId,'com.astha.companion');
 assert.match(read('tools/experience.js'),/const PREF_KEY = 'astha\.accessibility\.v2'/,'account and kit storage compatibility is preserved');
});

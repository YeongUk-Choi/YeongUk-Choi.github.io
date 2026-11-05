/* RSM Studio: local input, immutable worker requests, canvas display. The saved
   session contains original CIF text and settings, never a lab-code credential. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id), C = window.RsmCore;
  const ids = ['substrate','film'], cellKeys = ['a','b','c','alpha','beta','gamma'];
  const names = {substrate:'기판',film:'박막'}, colors = {substrate:'#0284c7',film:'#e97417'};
  const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const slots = {substrate:null,film:null}, loads = {substrate:0,film:0};
  let worker, generation = 0, timer, result, renderedState, selected, started = false, example = true, sessionRequest = 0;
  let pins = [], exportReady = false;
  const plot = {left:85,top:35,right:795,bottom:615};
  const num = (id, min=-Infinity, max=Infinity) => {
    const el = $(id), value = el && el.value.trim() !== '' ? Number(el.value) : NaN;
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${el?.closest('label')?.firstChild?.textContent?.trim() || id}: ${min}–${max} 범위의 수를 입력하세요.`);
    return value;
  };
  function vector(id) {
    const values = $(id).value.trim().split(/[\s,]+/).map(Number);
    if (values.length !== 3 || values.some(v=>!Number.isInteger(v)||Math.abs(v)>24) || values.every(v=>v===0)) throw new Error(`${id.endsWith('-out')?'표면 (hkl)':'면내 [uvw]'}: 0 0 1처럼 정수 세 개를 입력하세요.`);
    return values;
  }
  function numberField(id,label,value,min,max,step='any') {
    return `<label>${label}<input id="${id}" type="number" value="${value}" min="${min}" max="${max}" step="${step}"></label>`;
  }
  function setupLayer(id) {
    const film = id==='film';
    $(id+'-inputs').innerHTML = `<label class="rsm-drop" id="${id}-drop">${names[id]} CIF 파일 선택 · 끌어놓기<input id="${id}-file" type="file" accept=".cif,text/plain"></label>
      <select id="${id}-block" aria-label="${names[id]} CIF 블록" hidden></select><p id="${id}-status" class="rsm-layer-status">CIF를 읽지 않았습니다.</p>
      <details><summary>CIF 텍스트 붙여넣기</summary><textarea id="${id}-text" aria-label="${names[id]} CIF 텍스트" spellcheck="false"></textarea><button id="${id}-parse">텍스트 읽기</button><button id="${id}-download">원본 CIF 저장</button></details>
      ${film?'':'<label class="rsm-check"><input id="substrate-unlock" type="checkbox">기판 격자 편집 잠금 해제</label>'}
      <fieldset class="rsm-fieldset" id="${id}-cell-fields" ${film?'':'disabled'}><div class="rsm-grid3 rsm-cell">${cellKeys.map((key,i)=>`<label>${['a (Å)','b (Å)','c (Å)','α (°)','β (°)','γ (°)'][i]}<input id="${id}-${key}" type="number" step="${i<3?'0.001':'0.1'}" value="${i<3?'3.905':'90'}"><input id="${id}-${key}-slider" aria-label="${names[id]} ${key} 슬라이더" type="range" min="${i<3?'3':'80'}" max="${i<3?'5':'100'}" step="${i<3?'0.001':'0.1'}"></label>`).join('')}</div></fieldset>
      <div class="rsm-actions"><button id="${id}-reset">CIF 격자로 복원</button><button id="${id}-110">(110) / [1 −1 0]</button></div>
      <div class="rsm-grid2" style="margin-top:14px"><label>표면 (hkl)<input id="${id}-out" value="0 0 1" autocomplete="off"></label><label>면내 [uvw]<input id="${id}-in" value="1 0 0" autocomplete="off"></label>${numberField(id+'-tilt','틸트 y (°)',0,-15,15,'0.01')}${numberField(id+'-azimuth','방위각 z (°)',0,-180,180,'0.1')}</div>
      <details ${film?'open':''}><summary>시료 폭 · 상대 세기</summary><div class="rsm-grid2">
      ${film?numberField(id+'-thickness','두께 (nm)',50,1,2000,'1'):''}
      ${film?numberField(id+'-coherence','면내 결맞음 (nm)',150,1,100000,'10'):numberField(id+'-width','유효 Gaussian FWHM (Å⁻¹)',0.001,0.000001,0.1,'0.0001')}
      ${numberField(id+'-mosaic','모자이크 FWHM (°)',film?0.08:0.01,0,5,'0.01')}
      ${numberField(id+'-strain','변형폭 FWHM Δd/d',film?0.0005:0,0,0.1,'0.0001')}
      ${numberField(id+'-scale','세기 배율',film?0.4:1,0,100,'0.1')}</div></details>
      ${film?'<details><summary>박막 변이체</summary><label>도메인<select id="domains"><option value="single">단일 도메인</option><option value="90">면내 90° · 4변이체</option><option value="180">면내 180° · 2변이체</option><option value="twin">±y 틸트 · 2변이체</option></select></label>'+numberField('twin-angle','쌍정 틸트 ± (°)',0.25,0,10,'0.01')+'<p class="rsm-note">동일한 부피분율로 비간섭 세기를 합산합니다.</p></details>':''}`;
    $(id+'-file').addEventListener('change',e=>readFile(id,e.target.files[0]));
    $(id+'-drop').addEventListener('dragover',e=>{e.preventDefault();$(id+'-drop').classList.add('dragover');});
    $(id+'-drop').addEventListener('dragleave',()=>$(id+'-drop').classList.remove('dragover'));
    $(id+'-drop').addEventListener('drop',e=>{e.preventDefault();$(id+'-drop').classList.remove('dragover');readFile(id,e.dataTransfer.files[0]);});
    $(id+'-parse').addEventListener('click',()=>{loads[id]++;acceptText(id,$(id+'-text').value,'붙여넣은 CIF');});
    $(id+'-block').addEventListener('change',()=>parseBlock(id));
    $(id+'-download').addEventListener('click',()=>{if(slots[id])download(slots[id].raw,`${id}.cif`,'chemical/x-cif');});
    $(id+'-reset').addEventListener('click',()=>{if(slots[id]?.parsed){setCell(id,slots[id].parsed.cell);customStrain();schedule();}});
    $(id+'-110').addEventListener('click',()=>{$(id+'-out').value='1 1 0';$(id+'-in').value='1 -1 0';customStrain();schedule();});
    cellKeys.forEach(key=>{
      $(id+'-'+key+'-slider').addEventListener('input',()=>{$(id+'-'+key).value=$(id+'-'+key+'-slider').value;customStrain();schedule();});
      $(id+'-'+key).addEventListener('input',()=>{$(id+'-'+key+'-slider').value=$(id+'-'+key).value;customStrain();schedule();});
    });
    $(id+'-inputs').querySelectorAll('input,select').forEach(el=>{
      if (el.type==='file'||el.type==='range'||cellKeys.some(k=>el.id===id+'-'+k)||el.id.endsWith('-block')) return;
      el.addEventListener('input',()=>{customStrain();schedule();});
    });
  }
  function setCell(id, cell) {
    cellKeys.forEach((key,i)=>{
      $(id+'-'+key).value=Number(cell[key].toFixed(6));
      const ref=slots[id]?.parsed?.cell[key] || cell[key],slider=$(id+'-'+key+'-slider');
      const lo=i<3?ref*0.8:Math.max(1,ref-20),hi=i<3?ref*1.2:Math.min(179,ref+20);
      slider.min=lo;slider.max=hi;slider.value=cell[key];
      $(id+'-'+key).min=lo;$(id+'-'+key).max=hi;
    });
  }
  async function readFile(id,file) {
    if(!file)return;
    sessionRequest++;
    const seq=++loads[id];
    invalidate('CIF를 읽고 있습니다…'); slots[id]=null;
    if(file.size>512*1024){layerError(id,'CIF는 512 KiB 이하여야 합니다.');return;}
    try{const text=await file.text();if(seq===loads[id])acceptText(id,text,file.name);}catch(e){if(seq===loads[id])layerError(id,e.message);}
  }
  function layerError(id,msg) {
    const el=$(id+'-status');el.textContent=msg;el.classList.add('error');invalidate(`${names[id]} CIF 오류: ${msg}`,true);
  }
  function acceptText(id,text,name) {
    sessionRequest++;
    invalidate('CIF를 검증하고 있습니다…');slots[id]=null;
    try{
      const blocks=RsmCif.blocks(text);
      slots[id]={raw:text,name,block:blocks[0],parsed:null};
      $(id+'-block').innerHTML=blocks.map(b=>`<option value="${esc(b)}">${esc(b)}</option>`).join('');
      $(id+'-block').hidden=blocks.length<2;$(id+'-text').value=text;
      if(blocks.length>1){$(id+'-block').insertAdjacentHTML('afterbegin','<option value="" selected>계산할 data_ 블록을 선택하세요</option>');layerError(id,'여러 CIF 블록이 있습니다. 사용할 블록을 선택하세요.');return;}
      parseBlock(id);
    }catch(e){layerError(id,e.message);}
  }
  function parseBlock(id) {
    sessionRequest++;
    const slot=slots[id];if(!slot)return;
    try{
      const block=$(id+'-block').value;if(!block)throw new Error('계산할 CIF 블록을 선택하세요.');
      slot.parsed=RsmCif.parse(slot.raw,block);slot.block=block;
      const unsupported=[...new Set(slot.parsed.expandedAtoms.map(a=>a.element))].filter(e=>!RsmFactors.supports(e));
      if(unsupported.length)throw new Error(`IT92 원자산란인자를 지원하지 않는 원소: ${unsupported.join(', ')}`);
      setCell(id,slot.parsed.cell);
      $(id+'-status').classList.remove('error');
      $(id+'-status').textContent=`${slot.name} · ${slot.parsed.formula || block}\n${slot.parsed.spaceGroup || '명시적 대칭 연산'} · 전개 원자 ${slot.parsed.expandedAtoms.length}개`;
      customStrain();schedule();
    }catch(e){slot.parsed=null;layerError(id,e.message);}
  }
  function customStrain(){ $('strain-status').textContent='직접 격자 모드 · R을 적용하지 않았습니다.'; }
  function layerState(id) {
    const slot=slots[id];if(!slot?.parsed)throw new Error(`${names[id]} CIF를 먼저 읽어 주세요.`);
    const cell={};cellKeys.forEach((key,i)=>{const ref=slot.parsed.cell[key];cell[key]=num(id+'-'+key,i<3?ref*0.8:Math.max(1,ref-20),i<3?ref*1.2:Math.min(179,ref+20));});
    const layer={id,cell,parsed:slot.parsed,out:vector(id+'-out'),in:vector(id+'-in'),tilt:num(id+'-tilt',-15,15),azimuth:num(id+'-azimuth',-180,180),scale:num(id+'-scale',0,100),mosaicDeg:num(id+'-mosaic',0,5),microstrain:num(id+'-strain',0,0.1)};
    if(id==='film'){
      layer.thicknessNm=num('film-thickness',1,2000);
      layer.coherenceNm=num('film-coherence',1,100000);
      const d=$('domains').value,angle=num('twin-angle',0,10);
      layer.variants=d==='90'?[0,90,180,270].map(azimuth=>({azimuth,tilt:0,weight:.25})):d==='180'?[0,180].map(azimuth=>({azimuth,tilt:0,weight:.5})):d==='twin'?[-angle,angle].map(tilt=>({tilt,azimuth:0,weight:.5})):[{tilt:0,azimuth:0,weight:1}];
    } else layer.substrateFwhm=num('substrate-width',.000001,.1);
    return layer;
  }
  function readState() {
    const width=num('resolution',360,600),xmin=num('xmin',-4,4),xmax=num('xmax',-4,4),ymin=num('ymin',-4,4),ymax=num('ymax',-4,4);
    if(!(xmax>xmin&&ymax>ymin))throw new Error('지도 범위는 min < max 여야 합니다.');
    const maxIndex=num('max-index',1,12);if(!Number.isInteger(maxIndex))throw new Error('최대 지수는 정수여야 합니다.');
    const state={substrate:layerState('substrate'),film:layerState('film'),plane:$('plane').value,slice:num('slice',-4,4),grid:{width,height:Math.round(width*.75),xmin,xmax,ymin,ymax},lambda:num('lambda',.1,3),twoThetaMax:num('two-theta',1,179.9),instrument:{sigmaX:num('sigma-x',.000001,.1),sigmaY:num('sigma-x',.000001,.1),sigmaZ:num('sigma-z',.000001,.1)},maxIndex,qmax:num('qmax',.05,3.99),threshold:num('threshold',0,100)/100,mask:$('mask').checked&&$('plane').value==='xz'};
    return state;
  }
  function invalidate(message='',error=false){
    clearTimeout(timer);
    generation++;if(worker){worker.terminate();worker=null;}result=null;renderedState=null;exportReady=false;selected=null;
    ['export-png','export-svg','export-grid','export-csv','zoom','pin'].forEach(id=>$(id).disabled=true);
    $('status').textContent=message;$('status').classList.toggle('error',error);$('warnings').replaceChildren();$('reflections').replaceChildren();$('reflection-count').textContent='';$('selection').textContent='현재 입력으로 계산한 결과를 선택하세요.';
    $('map-empty').hidden=false;$('map-empty').textContent=message||'두 CIF를 불러오거나 예제를 선택하세요.';
    const ctx=$('map').getContext('2d');ctx.fillStyle='#f7f8fc';ctx.fillRect(0,0,900,700);
    const pc=$('profile').getContext('2d');pc.fillStyle='#f7f8fc';pc.fillRect(0,0,500,220);$('profile-info').textContent='현재 입력의 계산 결과가 없습니다.';
  }
  function schedule(){
    if(!started)return;sessionRequest++;clearTimeout(timer);invalidate('계산 준비 중…');timer=setTimeout(calculate,180);
  }
  function calculate(){
    let state;try{state=readState();}catch(e){invalidate(e.message,true);return;}
    $('energy').textContent=`광자 에너지 ${(12.39841984332/state.lambda).toFixed(4)} keV · λ를 바꿔도 격자 반사 좌표는 유지됩니다.`;
    $('energy-input').value=(12.39841984332/state.lambda).toFixed(6);
    const id=++generation;$('status').textContent='역격자 지도를 계산하고 있습니다…';
    worker=new Worker('assets/js/rsm-worker.js');
    worker.onmessage=e=>{
      if(e.data.id!==generation)return;
      worker.terminate();worker=null;
      if(e.data.error){invalidate(e.data.error,true);return;}
      result=e.data.result;renderedState=state;$('map-empty').hidden=true;
      $('status').textContent=`${result.reflections.length}개 반사 · 단면 밖 ${result.stats.planeExcluded}개 · 표시 기준 아래 ${result.stats.hidden}개 · ${state.grid.width} × ${state.grid.height} · ${Math.round(result.elapsedMs)} ms`;
      $('status').classList.remove('error');
      const warnings=[...ids.flatMap(k=>slots[k].parsed.warnings.map(w=>`${names[k]}: ${w}`)),...(result.warnings||[])];
      ids.forEach(k=>{if(cellKeys.some(key=>Math.abs(state[k].cell[key]-slots[k].parsed.cell[key])>1e-8))warnings.push(`${names[k]} 격자 변경: 분율 원자 좌표는 유지됩니다. 원본 공간군 표기는 수정된 셀의 대칭을 보증하지 않습니다.`);});
      $('warnings').replaceChildren(...[...new Set(warnings)].map(text=>{const p=document.createElement('p');p.textContent=text;return p;}));
      try {
        draw();table();drawProfile();exportReady=true;
        ['export-png','export-svg','export-grid','export-csv'].forEach(x=>$(x).disabled=false);
      } catch(error) { invalidate(error.message,true); }
    };
    worker.onerror=e=>invalidate(`계산 모듈을 실행하지 못했습니다: ${e.message}`,true);
    worker.postMessage({id,state});
  }
  const heatStops=[[0,[13,8,36]],[.25,[87,15,109]],[.5,[188,55,84]],[.75,[249,142,9]],[1,[252,255,164]]];
  function color(t){
    t=Math.max(0,Math.min(1,t));
    if($('palette').value==='jet')return [1.5-Math.abs(4*t-3),1.5-Math.abs(4*t-2),1.5-Math.abs(4*t-1)].map(v=>Math.round(255*Math.max(0,Math.min(1,v))));
    let i=1;while(i<heatStops.length-1&&heatStops[i][0]<t)i++;
    const [a,ac]=heatStops[i-1],[b,bc]=heatStops[i],f=(t-a)/(b-a);return ac.map((v,j)=>Math.round(v+(bc[j]-v)*f));
  }
  function unitFactors(){
    if($('units').value==='nm')return [10,10,'nm⁻¹'];
    if($('units').value==='rlu'){
      const s=renderedState?.substrate;
      if(!s||s.out.join()!=='0,0,1'||s.in.join()!=='1,0,0'||Math.abs(s.tilt)>1e-9||Math.abs(s.azimuth)>1e-9||['alpha','beta','gamma'].some(k=>Math.abs(s.cell[k]-90)>1e-6))throw new Error('rlu 축 표시는 직교 기판의 (001)/[100], 틸트·방위각 0에서 사용할 수 있습니다.');
      return [s.cell.a,renderedState.plane==='xz'?s.cell.c:s.cell.b,'rlu'];
    }
    return [1,1,'Å⁻¹'];
  }
  function mapXY(q){const g=result.grid;return [plot.left+(q[0]-g.xmin)/(g.xmax-g.xmin)*(plot.right-plot.left),plot.bottom-(q[1]-g.ymin)/(g.ymax-g.ymin)*(plot.bottom-plot.top)];}
  function showReflection(r){
    if($('display-layer').value!=='total'&&r.layer!==$('display-layer').value)return false;
    const i=renderedState.plane==='xz'?1:2;
    if(r.inSlice===false)return false;
    if(r.inSlice==null&&Math.abs(r.q[i]-renderedState.slice)>.006)return false;
    if(renderedState.mask&&!C.accessible(r.q[0],r.q[2],renderedState.lambda,renderedState.twoThetaMax).accessible)return false;
    return true;
  }
  function draw(){
    if(!result)return;let factors;try{factors=unitFactors();}catch(e){$('units').value='A';factors=unitFactors();$('status').textContent=e.message;}
    $('geometry-legend').textContent=renderedState.plane==='xy'?'면내 단면 · 접근 영역 표시 없음':renderedState.mask?'면외 반사 기하 · 회색 = 접근 불가':'면외 단면 · 접근 영역 표시 꺼짐';
    const ctx=$('map').getContext('2d'),{width,height}=result,g=result.grid,values=result[$('display-layer').value],decades=num('decades',1,10);
    const vmax=result.max || Math.max(...values.subarray(0,10000))||1;
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const small=canvas.getContext('2d'),data=small.createImageData(width,height);
    for(let row=0;row<height;row++)for(let col=0;col<width;col++){
      const idx=row*width+col, dst=((height-1-row)*width+col)*4;
      const qx=g.xmin+(col+.5)*(g.xmax-g.xmin)/width,qv=g.ymin+(row+.5)*(g.ymax-g.ymin)/height;
      const allowed=!renderedState.mask||C.accessible(qx,qv,renderedState.lambda,renderedState.twoThetaMax).accessible;
      const value=values[idx],level=value>0?1+Math.log10(value/vmax)/decades:-1;
      const rgb=!allowed?[224,228,238]:level<=0?[247,248,252]:color(level);
      data.data[dst]=rgb[0];data.data[dst+1]=rgb[1];data.data[dst+2]=rgb[2];data.data[dst+3]=255;
    }
    small.putImageData(data,0,0);ctx.fillStyle='#f7f8fc';ctx.fillRect(0,0,900,700);ctx.imageSmoothingEnabled=false;
    ctx.drawImage(canvas,plot.left,plot.top,plot.right-plot.left,plot.bottom-plot.top);
    ctx.strokeStyle='#bcc2d0';ctx.lineWidth=1;ctx.strokeRect(plot.left,plot.top,plot.right-plot.left,plot.bottom-plot.top);
    ctx.font='13px -apple-system, sans-serif';ctx.fillStyle='#45506a';ctx.textAlign='center';
    for(let i=0;i<=5;i++){
      const x=g.xmin+(g.xmax-g.xmin)*i/5,y=g.ymin+(g.ymax-g.ymin)*i/5;
      const xp=mapXY([x,g.ymin])[0],yp=mapXY([g.xmin,y])[1];ctx.fillText((x*factors[0]).toFixed(3),xp,plot.bottom+24);ctx.textAlign='right';ctx.fillText((y*factors[1]).toFixed(3),plot.left-12,yp+4);ctx.textAlign='center';
    }
    ctx.font='15px -apple-system, sans-serif';ctx.fillText(`qx (${factors[2]})`,(plot.left+plot.right)/2,plot.bottom+56);
    ctx.save();ctx.translate(22,(plot.top+plot.bottom)/2);ctx.rotate(-Math.PI/2);ctx.fillText(`q${renderedState.plane==='xz'?'z':'y'} (${factors[2]})`,0,0);ctx.restore();
    ctx.font='12px -apple-system, sans-serif';ctx.textAlign='left';ctx.fillText(`λ ${renderedState.lambda} Å · q = 1/d · ${example?'Synthetic example':'User CIFs'}`,plot.left,20);
    for(let i=0;i<220;i++){ctx.fillStyle=`rgb(${color(1-i/219).join(',')})`;ctx.fillRect(824,plot.top+40+i,16,1.5);}
    ctx.fillStyle='#45506a';ctx.fillText('1',846,plot.top+45);ctx.fillText(`10⁻${decades}`,846,plot.top+260);ctx.save();ctx.translate(851,plot.top+110);ctx.rotate(Math.PI/2);ctx.fillText('I / Imax',0,0);ctx.restore();
    ctx.save();ctx.beginPath();ctx.rect(plot.left,plot.top,plot.right-plot.left,plot.bottom-plot.top);ctx.clip();
    const visible=result.reflections.filter(showReflection).sort((a,b)=>b.F2-a.F2);
    const occupied=[];
    for(const r of visible){
      const q=r.projected || [r.q[0],r.q[renderedState.plane==='xz'?2:1]], [x,y]=mapXY(q);if(x<plot.left||x>plot.right||y<plot.top||y>plot.bottom)continue;
      ctx.strokeStyle=colors[r.layer];ctx.lineWidth=selected===r?2.5:1.2;
      ctx.beginPath();if(r.layer==='film')ctx.arc(x,y,selected===r?7:4,0,Math.PI*2);else ctx.rect(x-4,y-4,8,8);ctx.stroke();
      if($('labels').checked&&occupied.length<32&&!occupied.some(p=>Math.abs(p[0]-x)<55&&Math.abs(p[1]-y)<22)){
        ctx.font='11px -apple-system, sans-serif';ctx.textAlign='center';ctx.fillStyle='#202b42';const text=`${r.h} ${r.k} ${r.l}`;ctx.fillText(text,x,y-10);occupied.push([x,y]);
      }
    }
    ctx.restore();ctx.textAlign='left';
  }
  function table(){
    const visible=r=>showReflection(r)&&r.status!=='outside-view';
    const rows=result.reflections.slice().sort((a,b)=>Number(visible(b))-Number(visible(a))||b.F2-a.F2);$('reflection-count').textContent=rows.length>600?`· 현재 단면 우선 600개 / 전체 ${rows.length}개 (전체는 CSV)`:`· ${rows.length}개`;
    const frag=document.createDocumentFragment();
    rows.slice(0,600).forEach(r=>{const tr=document.createElement('tr'),two=2*Math.asin(Math.min(1,r.qabs*renderedState.lambda/2))*180/Math.PI;
      tr.innerHTML=`<td style="color:${colors[r.layer]}">${names[r.layer]}</td><td><button>${r.h} ${r.k} ${r.l}</button></td>${r.q.map(v=>`<td>${v.toFixed(5)}</td>`).join('')}<td>${(1/r.qabs).toFixed(4)}</td><td>${r.F2.toPrecision(4)}</td><td>${r.qabs*renderedState.lambda/2<=1?two.toFixed(3):'—'}</td><td>${r.variant+1}</td>`;
      tr.querySelector('button').addEventListener('click',()=>select(r));frag.append(tr);
    });$('reflections').replaceChildren(frag);
  }
  function select(r){
    selected=r;const omitted=renderedState.plane==='xz'?1:2;
    $('selection').textContent=`${names[r.layer]} (${r.h} ${r.k} ${r.l}) · 변이체 ${r.variant+1}\nq = [${r.q.map(v=>v.toFixed(6)).join(', ')}] Å⁻¹\nd = ${(1/r.qabs).toFixed(5)} Å · |F|² = ${r.F2.toPrecision(6)}\n단면과 거리 ${Math.abs(r.q[omitted]-renderedState.slice).toFixed(6)} Å⁻¹`;
    if(!r.inSlice)$('selection').textContent+=' · 현재 단면 밖: 고정 q 값을 조절하세요.';
    else if(renderedState.mask&&r.accessible===false)$('selection').textContent+=' · 현재 기하에서 접근 불가';
    $('zoom').disabled=$('pin').disabled=false;draw();
  }
  function drawProfile(){
    const canvas=$('profile'),ctx=canvas.getContext('2d'),t=num('film-thickness',1,2000),range=3/(10*t);
    ctx.fillStyle='#f7f8fc';ctx.fillRect(0,0,500,220);ctx.strokeStyle='#9ca3b5';ctx.beginPath();ctx.moveTo(45,15);ctx.lineTo(45,175);ctx.lineTo(480,175);ctx.stroke();
    ctx.strokeStyle='#e97417';ctx.lineWidth=2;ctx.beginPath();for(let i=0;i<=430;i++){const dq=-range+2*range*i/430,x=45+i,y=175-150*C.thicknessLine(dq,t);i?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.stroke();
    ctx.fillStyle='#45506a';ctx.font='12px sans-serif';ctx.textAlign='center';ctx.fillText('Δq along film normal (Å⁻¹)',260,212);ctx.fillText('0',260,192);ctx.fillText((-range).toFixed(4),55,192);ctx.fillText(range.toFixed(4),465,192);ctx.textAlign='left';ctx.fillText('1',26,28);
    $('profile-info').textContent=`t = ${t} nm · 영점 간격 1/t = ${(1/(10*t)).toPrecision(4)} Å⁻¹ · 표면 법선 방향`;
  }
  function exportText(kind){
    if(!exportReady)return;
    if(kind==='csv'){
      const header='layer,h,k,l,qx_A-1,qy_A-1,qz_A-1,d_A,F2,relative,variant,weight';
      download([header,...result.reflections.map(r=>[r.layer,r.h,r.k,r.l,...r.q,1/r.qabs,r.F2,r.relative,r.variant,r.weight].join(','))].join('\n'),'rsm-reflections.csv','text/csv');return;
    }
    const {width,height,grid}=result,rows=[`# RSM Studio; q=1/d; Å^-1; plane=${renderedState.plane}; slice=${renderedState.slice}; lambda_A=${renderedState.lambda}`,'# q_horizontal q_vertical I_substrate I_film I_total'];
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*width+x;rows.push([grid.xmin+(x+.5)*(grid.xmax-grid.xmin)/width,grid.ymin+(y+.5)*(grid.ymax-grid.ymin)/height,result.substrate[i],result.film[i],result.total[i]].join(' '));}
    download(rows.join('\n'),'rsm-grid.txt','text/plain');
  }
  function download(content,name,type){
    const url=URL.createObjectURL(content instanceof Blob?content:new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function saveSession(){
    let state;try{state=readState();}catch(e){$('status').textContent=e.message;return;}
    const inputs={};$('rsm-app').querySelectorAll('input,select').forEach(el=>{if(el.id&&el.type!=='file')inputs[el.id]=el.type==='checkbox'?el.checked:el.value;});
    download(JSON.stringify({format:'rsm-studio',version:1,example,cifs:Object.fromEntries(ids.map(id=>[id,{text:slots[id].raw,block:slots[id].block,name:slots[id].name}])),inputs},null,2),'rsm-settings.json','application/json');
  }
  async function loadSession(file){
    if(!file)return;
    const request=++sessionRequest;
    ids.forEach(id=>loads[id]++);
    invalidate('설정을 읽고 있습니다…');
    try{
      if(file.size>2*1024*1024)throw new Error('설정 파일은 2 MiB 이하여야 합니다.');
      const text=await file.text();if(request!==sessionRequest)return;
      const saved=JSON.parse(text);if(saved.format!=='rsm-studio'||saved.version!==1||!saved.cifs||!saved.inputs)throw new Error('지원하지 않는 설정 파일입니다.');
      const parsed={};for(const id of ids){const c=saved.cifs[id];if(!c||typeof c.text!=='string')throw new Error('설정에 CIF 원문이 없습니다.');parsed[id]=RsmCif.parse(c.text,c.block);}
      for(const id of ids){const c=saved.cifs[id];slots[id]={raw:c.text,block:c.block,name:String(c.name||id),parsed:parsed[id]};$(id+'-text').value=c.text;$(id+'-block').innerHTML=RsmCif.blocks(c.text).map(b=>`<option ${b===c.block?'selected':''}>${esc(b)}</option>`).join('');$(id+'-block').hidden=RsmCif.blocks(c.text).length<2;$(id+'-status').textContent=`${slots[id].name} · 전개 원자 ${parsed[id].expandedAtoms.length}개`;$(id+'-status').classList.remove('error');setCell(id,parsed[id].cell);loads[id]++;}
      for(const [id,value] of Object.entries(saved.inputs)){const el=$(id);if(el&&el.closest('#rsm-app')&&['INPUT','SELECT'].includes(el.tagName)&&el.type!=='file'&&!id.endsWith('-block')){if(el.type==='checkbox')el.checked=value===true;else if(typeof value==='string'&&value.length<100)el.value=value;}}
      example=saved.example===true;$('data-origin').textContent=example?'합성 예제 · 실제 시료 아님':'사용자 CIF';$('substrate-cell-fields').disabled=!$('substrate-unlock').checked;planeNote();customStrain();readState();schedule();
    }catch(e){if(request===sessionRequest)invalidate(`설정 오류: ${e.message}`,true);}
  }
  function planeNote(){
    const xy=$('plane').value==='xy';$('slice-label').firstChild.textContent=`고정 q${xy?'z':'y'} (Å⁻¹)`;$('mask').disabled=xy;
    $('geometry-legend').textContent=xy?'면내 단면 · 접근 영역 표시 없음':'면외 반사 기하 · 회색 = 접근 불가';
    $('plane-note').textContent=xy?'고정 qz의 면내 단면 · 표면 법선 z와 평면이 90°. GI 기하의 접근 가능 영역은 적용하지 않습니다.':'기판 표면 법선 z를 포함하는 면외 단면. 표면과 평면이 90°. 반사 기하의 접근 가능 영역을 표시합니다.';
  }
  function defaultBounds(){const xy=$('plane').value==='xy';$('xmin').value=-1.05;$('xmax').value=1.05;$('ymin').value=xy?-1.05:0;$('ymax').value=xy?1.05:1.25;$('slice').value=0;}
  function start(){
    if(started)return;started=true;ids.forEach(setupLayer);
    $('substrate-unlock').addEventListener('change',()=>$('substrate-cell-fields').disabled=!$('substrate-unlock').checked);
    $('demo').addEventListener('click',()=>{
      example=true;$('data-origin').textContent='합성 예제 · 실제 시료 아님';
      ids.forEach(id=>{loads[id]++;acceptText(id,RsmExamples[id],id==='substrate'?'STO 예제':'가상 입방 박막');$(id+'-out').value='0 0 1';$(id+'-in').value='1 0 0';$(id+'-tilt').value=0;$(id+'-azimuth').value=0;});
      $('film-c').value=4.02;$('film-c-slider').value=4.02;$('domains').value='single';defaultBounds();schedule();
    });
    ids.forEach(id=>{[id+'-file',id+'-parse',id+'-drop'].forEach(key=>$(key).addEventListener(key.endsWith('-parse')?'click':key.endsWith('-drop')?'drop':'change',()=>{example=false;$('data-origin').textContent='사용자 CIF';}));});
    ['lambda','two-theta','sigma-x','sigma-z','mask','max-index','qmax','threshold','resolution','xmin','xmax','ymin','ymax','slice'].forEach(id=>$(id).addEventListener('input',schedule));
    $('energy-input').addEventListener('input',()=>{try{$('lambda').value=(12.39841984332/num('energy-input',12.39841984332/3,12.39841984332/.1)).toFixed(9);schedule();}catch(e){invalidate(e.message,true);}});
    ['units','display-layer','palette','decades','labels'].forEach(id=>$(id).addEventListener('input',()=>{try{if(result)draw();else schedule();}catch(e){invalidate(e.message,true);}}));
    $('plane').addEventListener('change',()=>{planeNote();defaultBounds();schedule();});
    $('reset-view').addEventListener('click',()=>{defaultBounds();schedule();});
    $('relax-slider').addEventListener('input',()=>{$('relaxation').value=$('relax-slider').value;applyStrain();});
    $('relaxation').addEventListener('input',()=>$('relax-slider').value=$('relaxation').value);
    $('apply-strain').addEventListener('click',applyStrain);
    $('zoom').addEventListener('click',()=>{if(!selected)return;const r=selected,w=num('zoom-width',.001,.5),j=$('plane').value==='xz'?2:1;const q=r.projected||[r.q[0],r.q[j]];$('xmin').value=(q[0]-w/2).toFixed(7);$('xmax').value=(q[0]+w/2).toFixed(7);$('ymin').value=(q[1]-w/2).toFixed(7);$('ymax').value=(q[1]+w/2).toFixed(7);schedule();});
    $('pin').addEventListener('click',()=>{if(!selected)return;pins.push({...selected});if(pins.length>2)pins.shift();$('pins').replaceChildren(...pins.map(r=>{const el=document.createElement('p');el.className='rsm-pin';el.textContent=`고정 ${names[r.layer]} (${r.h} ${r.k} ${r.l}) : [${r.q.map(v=>v.toFixed(5)).join(', ')}] Å⁻¹`;return el;}));});
    $('map').addEventListener('pointermove',e=>{
      if(!result)return;const rect=$('map').getBoundingClientRect(),x=(e.clientX-rect.left)*900/rect.width,y=(e.clientY-rect.top)*700/rect.height;
      if(x<plot.left||x>plot.right||y<plot.top||y>plot.bottom)return;
      const g=result.grid,qx=g.xmin+(x-plot.left)/(plot.right-plot.left)*(g.xmax-g.xmin),qv=g.ymax-(y-plot.top)/(plot.bottom-plot.top)*(g.ymax-g.ymin),r=Math.hypot(qx,qv,renderedState.slice),two=r*renderedState.lambda/2;
      const geom=renderedState.plane==='xz'?C.accessible(qx,qv,renderedState.lambda,renderedState.twoThetaMax):null;
      $('cursor').textContent=`qx ${qx.toFixed(5)} · q${renderedState.plane==='xz'?'z':'y'} ${qv.toFixed(5)} Å⁻¹ · d ${r?(1/r).toFixed(4):'∞'} Å · 2θ ${two<=1?(2*Math.asin(two)*180/Math.PI).toFixed(3):'—'}°${geom&&geom.accessible?' · ω '+geom.omega.toFixed(3)+'°':''}`;
    });
    $('map').addEventListener('click',e=>{if(!result)return;const rect=$('map').getBoundingClientRect(),p=[(e.clientX-rect.left)*900/rect.width,(e.clientY-rect.top)*700/rect.height],j=renderedState.plane==='xz'?2:1;let nearest,best=24;for(const r of result.reflections.filter(showReflection)){const xy=mapXY(r.projected||[r.q[0],r.q[j]]),d=Math.hypot(xy[0]-p[0],xy[1]-p[1]);if(d<best){nearest=r;best=d;}}if(nearest)select(nearest);});
    $('export-png').addEventListener('click',()=>{if(exportReady)$('map').toBlob(b=>download(b,'rsm-map.png','image/png'));});
    $('export-svg').addEventListener('click',()=>{if(exportReady)download(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700" viewBox="0 0 900 700"><title>RSM Studio: ${renderedState.plane}, q=1/d, lambda ${renderedState.lambda} A</title><image width="900" height="700" href="${$('map').toDataURL('image/png')}"/></svg>`,'rsm-map.svg','image/svg+xml');});
    $('export-grid').addEventListener('click',()=>exportText('grid'));$('export-csv').addEventListener('click',()=>exportText('csv'));
    $('save-session').addEventListener('click',saveSession);$('load-session').addEventListener('change',e=>loadSession(e.target.files[0]));
    planeNote();$('demo').click();
  }
  function applyStrain(){
    try{
      const sub=layerState('substrate'),film=layerState('film');
      for(const layer of [sub,film])if(layer.out.join()!=='0,0,1'||layer.in.join()!=='1,0,0'||Math.abs(layer.tilt)>1e-8||Math.abs(layer.azimuth)>1e-8)throw new Error('변형 모드는 두 층 모두 (001)/[100], 틸트·방위각 0에서 지원됩니다.');
      const info=C.elastic(sub.cell,slots.film.parsed.cell,num('relaxation',0,1),num('poisson',0,.49));setCell('film',info.cell);schedule();
      $('strain-status').textContent=`R=${info.R.toFixed(2)} · misfit ${(100*info.misfit).toFixed(3)}% · ε∥ ${(100*info.epsilonParallel).toFixed(3)}% · ε⊥ ${(100*info.epsilonNormal).toFixed(3)}%`;
    }catch(e){$('strain-status').textContent=e.message;}
  }
  window.RsmApp={start};
})();

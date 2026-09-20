(function(root) {
  'use strict';
  function date(y, m, d) {
    const dt = new Date(Date.UTC(+y, +m - 1, +d));
    if (+y < 1900 || dt > new Date() || dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +m - 1 || dt.getUTCDate() !== +d) return '';
    return String(y) + String(m).padStart(2, '0') + String(d).padStart(2, '0');
  }
  function parse(text) {
    const lines = String(text || '').normalize('NFKC').split(/\r?\n/).map(s=>s.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
    let name = '', birth = '', address = '';
    const joined = lines.join('\n');
    const rrn = joined.match(/(?:^|\D)(\d{2})(\d{2})(\d{2})\s*[-–]\s*([1-4])(?:[\d*●•xX ]{6})(?!\d)/);
    if (rrn) birth = date((+rrn[4] <= 2 ? '19' : '20') + rrn[1], rrn[2], rrn[3]);
    // Do not guess the century of a masked six-digit birth date.
    if (!birth) {
      const labeled = joined.match(/생\s*년\s*월\s*일\s*[:：]?\s*((?:19|20)\d{2})[.년/ -]+(\d{1,2})[.월/ -]+(\d{1,2})/);
      if (labeled) birth = date(labeled[1], labeled[2], labeled[3]);
    }
    const labeledName = joined.match(/성\s*명\s*[:：]?\s*([가-힣]+(?: [가-힣]+)?)/);
    if (labeledName) name = labeledName[1].replace(/\s/g, '');
    if (!name) {
      const title = lines.findIndex(l=>/주민\s*등록\s*증|운전\s*면허\s*증/.test(l));
      if (title >= 0) {
        const candidates = lines.slice(title+1, title+5).map(l=>l.replace(/\s*\([^)]*\)/g,'').trim()).filter(l=>/^[가-힣]{2,5}$/.test(l) && !/면허|주소|등록|공화국|대한민국/.test(l));
        if (candidates.length === 1) name = candidates[0];
      }
    }
    if (!/^[가-힣]{2,10}$/.test(name)) name = '';
    const region = /^(?:주소\s*[:：]?\s*)?(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주|전북)/;
    const start = lines.findIndex(l=>region.test(l) && !/(?:청장|시장|구청장|군수)\s*$/.test(l));
    if (start >= 0) {
      const pieces=[];
      for(let i=start;i<Math.min(lines.length,start+4);i++) {
        const l=lines[i];
        if (/(?:청장|시장|구청장|군수)\s*$/.test(l) || /^\d{4}[.년/ -]/.test(l) || /발급|적성검사|갱신|면허번호/.test(l)) break;
        pieces.push(l.replace(/^주소\s*[:：]?\s*/,''));
      }
      address=pieces.join(' ').trim();
      if (!/\d/.test(address)) address='';
    }
    return {name,birth,address};
  }
  let library;
  function load() {
    if (root.Tesseract) return Promise.resolve(root.Tesseract);
    if (!library) library = new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src='https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
      script.onload=()=>root.Tesseract?resolve(root.Tesseract):reject(new Error('ocr_unavailable'));
      script.onerror=()=>reject(new Error('ocr_unavailable'));
      document.head.appendChild(script);
    }).catch(e=>{library=null;throw e;});
    return library;
  }
  function recognize(file,onProgress) {
    let worker, stopped=false, timer, rejectStop;
    const stopPromise=new Promise((_,reject)=>{rejectStop=reject;});
    const terminate=()=>{if(worker) Promise.resolve(worker.terminate()).catch(()=>{});};
    const task=(async()=>{
      const lib=await load();
      if(stopped) throw new Error('cancelled');
      worker=await lib.createWorker('kor+eng',1,{
        logger:m=>{if(!stopped && onProgress && m.status==='recognizing text') onProgress(m.progress);},
        workerPath:'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js',
        corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0',
        langPath:'https://tessdata.projectnaptha.com/4.0.0',
        cacheMethod:'write'
      });
      if(stopped) {terminate();throw new Error('cancelled');}
      await worker.setParameters({tessedit_pageseg_mode:'11'});
      const result=await worker.recognize(file);
      if(stopped) throw new Error('cancelled');
      return parse(result.data.text);
    })();
    const promise=Promise.race([task,stopPromise]).finally(()=>{clearTimeout(timer);terminate();});
    const cancel=()=>{stopped=true;terminate();rejectStop(new Error('cancelled'));};
    timer=setTimeout(cancel,45000);
    return {promise,cancel};
  }
  const api={parse,recognize};
  if(typeof module !== 'undefined' && module.exports) module.exports=api;
  else root.SeoryuIdOCR=api;
})(typeof window === 'undefined' ? globalThis : window);

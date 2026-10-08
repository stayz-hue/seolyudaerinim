(function(root) {
  'use strict';

  // Names are suggestions, never an identity verification or a calibrated score.
  // parse(text): {name,birth,address,nameStatus,candidates,nameSource,reviewRequired}
  // recognize(file, onProgress): {promise,cancel}; promise adds evidence entries
  // {angle,psm,name,nameStatus}. nameStatus = agreement | single | conflict | missing.
  // A conflict clears ALL suggested identity fields. Every result requires review.
  const TITLE = /주\s*민\s*등\s*록\s*증|운\s*전\s*면\s*허\s*증/;
  const REGION = /^(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|충북|충남|전라|전북|전남|경상|경북|경남|제주)/;
  const LABEL = /^성\s*명(?:\s*[:：]\s*|\s+|$)/;
  const PLACEHOLDERS = new Set(['성명','이름','주소','신청인','신청인이름','신분증이름','성명확인필요','확인필요','미확인','인식실패','신분증','주민등록증','운전면허증','대한민국']);

  function normalizeName(value) {
    return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, '').trim();
  }
  function isValidName(value) {
    const name = normalizeName(value);
    return /^[가-힣]{2,10}$/.test(name) && !PLACEHOLDERS.has(name);
  }
  function date(y, m, d) {
    const dt = new Date(Date.UTC(+y, +m - 1, +d));
    if (+y < 1900 || dt > new Date() || dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +m - 1 || dt.getUTCDate() !== +d) return '';
    return String(y) + String(m).padStart(2, '0') + String(d).padStart(2, '0');
  }
  function unique(values) { return [...new Set(values.filter(Boolean))]; }
  function consensus(values) {
    const found = unique(values);
    return found.length === 1 ? found[0] : '';
  }
  function addressLine(value) {
    return String(value || '').replace(/^주소[ \t]*[:：]?[ \t]*/, '')
      .replace(/^서\s*울\s*특\s*별\s*시/, '서울특별시')
      .replace(/^경\s*기\s*도/, '경기도')
      .replace(/(\d)[ \t]+(동|호)(?=[ \t]|$)/g, '$1$2');
  }
  function isAddressOrIssuer(value) {
    const compact = normalizeName(value);
    return REGION.test(compact) || /주소|거주지|발급|청장|경찰청|구청|시장|군수|시청|공화국|면허|등록|적성검사|갱신|주민번호|생년월일|신청인|본인|도로명|일반|보통|대형|소형|원동기|장기등기증/.test(compact);
  }
  function nameOnLine(value) {
    // Only ONE line: \s in a capture used to join the following address/issuer.
    // A parenthesized Hanja/romanization suffix is allowed; other trailing text
    // is not silently discarded, and digits are never interpreted as Hangul.
    const candidate = String(value || '').replace(/[（]/g, '(').replace(/[）]/g, ')').trim();
    const match = candidate.match(/^([가-힣](?:[ \t]*[가-힣]){1,9})(?:[ \t]*\([^()]*\))?[ \t]*$/);
    if (!match) return '';
    const name = normalizeName(match[1]);
    return isValidName(name) && !isAddressOrIssuer(name) ? name : '';
  }
  function parse(text) {
    const lines = String(text || '').normalize('NFKC').split(/\r\n?|\n/).map(s => s.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
    const joined = lines.join('\n');
    let birth = '', address = '';
    const births = [];
    // The first digit AFTER the dash establishes the century. Six digits alone
    // (or a completely masked suffix) deliberately cannot establish a birthday.
    // OCR may merge a run of masking marks into fewer marks. The six date
    // digits and the century digit must still be read exactly; truncated
    // numeric suffixes and a masked century are never used to guess a date.
    const rrnPattern = /(?:^|[^\d])(\d{2})(\d{2})(\d{2})[ \t]*[-–][ \t]*([1-4])(?:(?:[\d*●•xX#¥][ \t]*){6}|(?:[*●•xX#¥~][ \t]*){1,6})(?![\d*●•xX#¥~])/g;
    for (const rrn of joined.matchAll(rrnPattern)) births.push(date((+rrn[4] <= 2 ? '19' : '20') + rrn[1], rrn[2], rrn[3]));
    const labeledDates = /생[ \t]*년[ \t]*월[ \t]*일[ \t]*[:：]?[ \t]*((?:19|20)\d{2})[.년/ -]+(\d{1,2})[.월/ -]+(\d{1,2})/g;
    for (const value of joined.matchAll(labeledDates)) births.push(date(value[1], value[2], value[3]));
    birth = consensus(births);

    const named = [];
    for (let i = 0; i < lines.length; i++) {
      if (!LABEL.test(lines[i])) continue;
      const rest = lines[i].replace(LABEL, '').trim();
      const name = nameOnLine(rest || lines[i + 1]);
      if (name) named.push({name, source:'label'});
    }
    for (let i = 0; i < lines.length; i++) {
      if (!TITLE.test(lines[i])) continue;
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        if (/^주소|^생[ \t]*년[ \t]*월[ \t]*일|^\d{6}[ \t]*[-–]|발급|적성검사|갱신/.test(lines[j]) || REGION.test(normalizeName(lines[j]))) break;
        if (LABEL.test(lines[j])) continue;
        const name = nameOnLine(lines[j]);
        if (name) named.push({name, source:'title'});
      }
    }
    const candidates = unique(named.map(item => item.name));
    const name = candidates.length === 1 ? candidates[0] : '';
    const nameStatus = candidates.length > 1 ? 'conflict' : name ? 'single' : 'missing';

    const start = lines.findIndex(line => REGION.test(normalizeName(addressLine(line))) && !/(?:청장|시장|구청장|군수|경찰청)$/.test(normalizeName(line)));
    if (start >= 0) {
      const pieces = [];
      for (let i = start; i < Math.min(lines.length, start + 4); i++) {
        const line = lines[i];
        if (/(?:청장|시장|구청장|군수|경찰청)$/.test(normalizeName(line)) || /^\d{4}[.년/ -]/.test(line) || /^\d{6}[ \t]*[-–]/.test(line) || /발급|적성검사|갱신|면허번호/.test(line) || TITLE.test(line) || LABEL.test(line)) break;
        if (i > start && REGION.test(normalizeName(addressLine(line)))) break;
        pieces.push(addressLine(line));
      }
      address = pieces.join(' ').trim();
      if (!/\d/.test(address)) address = '';
    }
    return {name, birth:nameStatus === 'conflict' ? '' : birth, address:nameStatus === 'conflict' ? '' : address, nameStatus, candidates, nameSource:name ? named.find(item => item.name === name).source : '', reviewRequired:true};
  }

  let library;
  function load() {
    if (root.Tesseract) return Promise.resolve(root.Tesseract);
    if (!library) library = new Promise((resolve, reject) => {
      const script = root.document.createElement('script');
      let settled = false, loadTimer;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(loadTimer);
        script.onload = null;
        script.onerror = null;
        if (error) {
          if (script.remove) script.remove();
          reject(error);
        } else resolve(root.Tesseract);
      };
      script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
      script.onload = () => finish(root.Tesseract ? null : new Error('ocr_unavailable'));
      script.onerror = () => finish(new Error('ocr_unavailable'));
      // A hung CDN download may fire neither event. Reset the shared promise so
      // a later attempt can download again instead of inheriting a permanent hang.
      loadTimer = setTimeout(() => finish(new Error('ocr_library_timeout')), 12000);
      try { root.document.head.appendChild(script); }
      catch (error) { finish(error); }
    }).catch(error => { library = null; throw error; });
    return library;
  }
  function recognize(file, onProgress) {
    let worker, terminatedWorker, bitmap, cancelDecode, stopped = false, finished = false, timer, rejectStop;
    const stopPromise = new Promise((_, reject) => { rejectStop = reject; });
    const terminate = () => {
      if (!worker || terminatedWorker === worker) return;
      terminatedWorker = worker;
      try { Promise.resolve(worker.terminate()).catch(() => {}); } catch (_) {}
    };
    const check = () => { if (stopped) throw new Error('cancelled'); };
    const closeBitmap = () => {
      if (!bitmap) return;
      const value = bitmap;
      bitmap = null;
      try { value.close(); } catch (_) {}
    };
    const stop = reason => {
      if (finished || stopped) return;
      stopped = true;
      if (cancelDecode) cancelDecode();
      terminate();
      closeBitmap();
      rejectStop(new Error(reason));
    };
    const decode = async () => {
      if (root.createImageBitmap) {
        try { return await root.createImageBitmap(file); }
        catch (error) { if (!root.Image || !root.URL) throw error; }
      }
      check();
      if (!root.Image || !root.URL || !root.URL.createObjectURL) return null;
      return new Promise((resolve, reject) => {
        const image = new root.Image(), url = root.URL.createObjectURL(file);
        const clear = () => { image.onload = image.onerror = null; root.URL.revokeObjectURL(url); cancelDecode = null; };
        cancelDecode = () => { clear(); image.src = ''; reject(new Error('cancelled')); };
        image.onload = () => { clear(); image.close = () => { image.src = ''; }; resolve(image); };
        image.onerror = () => { clear(); reject(new Error('ocr_image_unavailable')); };
        image.src = url;
      });
    };
    const task = (async () => {
      const lib = await load();
      check();
      worker = await lib.createWorker('kor', 1, {
        logger: message => { if (!stopped && !finished && onProgress && message.status === 'recognizing text') onProgress(message.progress); },
        workerPath:'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js',
        corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2',
        langPath:'https://tessdata.projectnaptha.com/4.0.0_best',
        cachePath:'seoryu-id-kor-best-v1',
        cacheMethod:'write'
      });
      if (stopped) { terminate(); check(); }
      const decoded = await decode();
      if (stopped) { if (decoded) { try { decoded.close(); } catch (_) {} } check(); }
      bitmap = decoded;
      // Keep more detail than the submission thumbnail, but bound WASM/canvas
      // memory for full-resolution phone photos in every orientation.
      const scale = bitmap ? Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height)) : 1;
      const observations = [];
      for (const angle of [0, 90, 180, 270]) {
        check();
        let input = file, canvas;
        try {
          if (angle && !bitmap) break;
          if (bitmap && (angle || scale < 1)) {
            canvas = root.document.createElement('canvas');
            canvas.width = Math.max(1, Math.round((angle % 180 ? bitmap.height : bitmap.width) * scale));
            canvas.height = Math.max(1, Math.round((angle % 180 ? bitmap.width : bitmap.height) * scale));
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('ocr_canvas_unavailable');
            ctx.translate(canvas.width / 2, canvas.height / 2);
            ctx.rotate(angle * Math.PI / 180);
            ctx.drawImage(bitmap, -bitmap.width * scale / 2, -bitmap.height * scale / 2, bitmap.width * scale, bitmap.height * scale);
            input = canvas;
          }
          // Sparse text and a single text block provide two readings of the SAME
          // orientation. Their agreement is evidence, NOT independent accuracy.
          for (const psm of [11, 6]) {
            check();
            await worker.setParameters({tessedit_pageseg_mode:String(psm)});
            check();
            const result = await worker.recognize(input);
            check();
            const parsed = parse(result && result.data && result.data.text);
            observations.push({angle, psm, parsed, text:result && result.data && result.data.text || ''});
          }
          // Check every orientation: a plausible name from sideways text must
          // not prevent us from reading the upright card or exposing a conflict.
        } finally {
          if (canvas) { canvas.width = 0; canvas.height = 0; }
        }
      }
      const candidates = unique(observations.flatMap(item => item.parsed.candidates));
      const conflict = candidates.length > 1 || observations.some(item => item.parsed.nameStatus === 'conflict');
      const name = !conflict && candidates.length === 1 ? candidates[0] : '';
      const anchoredAngles = new Set(observations.filter(item => item.parsed.name === name).map(item => item.angle));
      // A damaged title must not discard a second exact reading of an already
      // anchored name. Never use an unrelated orientation or guess a new name.
      const matching = observations.filter(item => name && (item.parsed.name === name ||
        (anchoredAngles.has(item.angle) && item.text.split(/\r?\n/).some(line => nameOnLine(line) === name))));
      const nameStatus = conflict ? 'conflict' : name ? (matching.length >= 2 ? 'agreement' : 'single') : 'missing';
      return {
        name,
        birth:!name ? '' : consensus(matching.map(item => item.parsed.birth)),
        address:!name ? '' : consensus(matching.map(item => item.parsed.address)),
        nameStatus, candidates, reviewRequired:true,
        evidence:observations.map(item => ({angle:item.angle, psm:item.psm, name:item.parsed.name, nameStatus:item.parsed.nameStatus}))
      };
    })();
    const promise = Promise.race([task, stopPromise]).finally(() => {
      finished = true;
      clearTimeout(timer);
      terminate();
      closeBitmap();
    });
    timer = setTimeout(() => stop('ocr_timeout'), 180000);
    return {promise, cancel:() => stop('cancelled')};
  }
  const api = {parse, recognize, normalizeName, isValidName};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SeoryuIdOCR = api;
})(typeof window === 'undefined' ? globalThis : window);

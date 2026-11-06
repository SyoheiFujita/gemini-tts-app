// Gemini TTS 音声生成 ― バックグラウンド処理と Google ドライブ保存
// スマホのページから文章を受け取り、裏で音声を作ってドライブに WAV で保存します。
// ページを閉じても処理は続きます。設定方法は README.md を参照してください。

// ===== 設定（書き換える所） =====
const FOLDER_ID = '1aMnHYz0Ko3SUah4WIdbfOkMvEkXgM6l1';   // 保存先フォルダ
const TOKEN = 'ここを合言葉に変更';                       // アプリの「合言葉」欄と同じもの
// Vertex AI 経由（Google Cloud の課金。GCP の無料クレジットが使える）
// 空欄にすると下の AI Studio の API キー経由に戻る（こちらは GCP クレジット対象外）
const VERTEX_PROJECT = 'gen-lang-client-0038328291';   // Google Cloud のプロジェクトID
const VERTEX_LOCATION = 'global';
const GEMINI_API_KEY = 'ここにGeminiのAPIキー';           // AI Studio 経由のときだけ使う（AQ. または AIza で始まる）
// ===================================

const API = 'https://generativelanguage.googleapis.com/v1beta';
const VERTEX_API = `https://${VERTEX_LOCATION === 'global' ? '' : VERTEX_LOCATION + '-'}aiplatform.googleapis.com/v1beta1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}`;
const DEFAULT_MODEL = 'gemini-3.8-flash-tts';
const DEFAULT_VOICE = VERTEX_PROJECT ? 'test1101-vertex' : 'test1101';
const MAX_CHARS = 3000;
const CHUNK_CHARS = 500;          // 1回のAPI呼び出しで読ませる文字数の目安
const SAMPLE_RATE = 24000;
const GAP_BYTES = 12000;          // 区切りの無音 0.25秒（6の倍数にしておく）
const BUDGET_MS = 4.5 * 60 * 1000; // 1回の実行で使う時間（上限6分に余裕を持たせる）
const props = PropertiesService.getScriptProperties();

// ---------- 受付 ----------
function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    // 合言葉は本文の token を優先し、空なら URL パラメータの token（?token=...）も受け付ける
    const bodyToken = String(req.token == null ? '' : req.token).trim();
    const urlToken = String(((e && e.parameter) || {}).token || '').trim();
    const bad = checkConfig_(bodyToken || urlToken);
    if (bad) return json_({ ok: false, error: bad });

    if (req.action === 'status') return json_({ ok: true, jobs: getStatuses_(req.ids || []) });
    if (req.action === 'voices') {
      return json_({ ok: true, voices: listVoices_().map(v => ({ id: v.id, name: voiceName_(v), type: v.type || '' })) });
    }

    const text = String(req.text || '').trim();
    if (!text) return json_({ ok: false, error: 'テキストが空です' });
    if ([...text].length > MAX_CHARS) return json_({ ok: false, error: `テキストは${MAX_CHARS}文字以内にしてください` });

    const id = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    const job = {
      id, text, chunks: splitText_(text),
      voice: String(req.voice || DEFAULT_VOICE), style: String(req.style || ''), model: String(req.model || DEFAULT_MODEL),
      filename: makeFilename_(text), parts: [], voiceId: '', createdAt: Date.now(),
    };
    saveJob_(job);
    setStatus_(id, { state: 'queued', done: 0, total: job.chunks.length, filename: job.filename });
    withLock_(() => { const q = queue_(); q.push(id); props.setProperty('queue', JSON.stringify(q)); });
    cleanupStatuses_();
    scheduleWorker_();
    return json_({ ok: true, id, total: job.chunks.length, filename: job.filename });
  } catch (err) {
    return json_({ ok: false, error: msg_(err) });
  }
}

function doGet() {
  return json_({ ok: true, message: 'TTS 保存用スクリプトは動作中です' });
}

// ---------- バックグラウンド処理（時間主導トリガーで動く） ----------
function worker() {
  const start = Date.now();
  deleteWorkerTriggers_();
  const busy = Number(props.getProperty('runningUntil') || 0);
  if (busy > start) { // 別の実行が動いている → その終了後にもう一度
    ScriptApp.newTrigger('worker').timeBased().after(busy - start + 5000).create();
    return;
  }
  props.setProperty('runningUntil', String(start + 6.5 * 60 * 1000));
  ScriptApp.newTrigger('worker').timeBased().after(7 * 60 * 1000).create(); // 強制終了されたときの保険
  try {
    while (Date.now() - start < BUDGET_MS) {
      const id = queue_()[0];
      if (!id) break;
      let finished;
      try { finished = processJob_(id, start); }
      catch (err) { failJob_(id, err); finished = true; }
      if (!finished) break; // 時間切れ。次の実行で続きから
    }
  } finally {
    props.deleteProperty('runningUntil');
    deleteWorkerTriggers_();
    if (queue_().length) ScriptApp.newTrigger('worker').timeBased().after(1000).create();
  }
}

function deleteWorkerTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'worker') ScriptApp.deleteTrigger(t); });
}

function processJob_(id, start) {
  const job = loadJob_(id);
  if (!job) { dequeue_(id); return true; }
  job.runs = (job.runs || 0) + 1;
  if (job.runs > 20) throw new Error('何度実行しても完了しませんでした（文章を短くして試してください）');
  saveJob_(job);

  if (!job.voiceId) { job.voiceId = resolveVoice_(job.voice); saveJob_(job); }

  while (job.parts.length < job.chunks.length) {
    if (Date.now() - start > BUDGET_MS) return false;
    const i = job.parts.length;
    setStatus_(id, { state: 'generating', done: i, total: job.chunks.length, filename: job.filename });
    const pcm = normalizePcm_(synthWithRetry_(job.chunks[i], job));
    const f = workFolder_().createFile(`part_${id}_${i}.b64`, pcm.b64, MimeType.PLAIN_TEXT);
    job.parts.push({ fid: f.getId(), bytes: pcm.bytes });
    saveJob_(job);
  }

  if (Date.now() - start > BUDGET_MS - 30 * 1000) return false; // 結合の時間を残す
  setStatus_(id, { state: 'saving', done: job.chunks.length, total: job.chunks.length, filename: job.filename });
  const file = assembleWav_(job);
  removeJobFiles_(job);
  dequeue_(id);
  setStatus_(id, { state: 'done', done: job.chunks.length, total: job.chunks.length, filename: file.getName(), url: file.getUrl() });
  return true;
}

function failJob_(id, err) {
  const job = loadJob_(id);
  const message = msg_(err);
  if (job) {
    const name = job.filename.replace(/\.wav$/, '') + '_エラー.txt';
    DriveApp.getFolderById(FOLDER_ID).createFile(name,
      `音声の生成に失敗しました。\n\nエラー: ${message}\n\n--- 本文 ---\n${job.text}`, MimeType.PLAIN_TEXT);
    removeJobFiles_(job);
  }
  dequeue_(id);
  setStatus_(id, { state: 'error', error: message, filename: job ? job.filename : '' });
}

// ---------- Gemini ----------
function synthWithRetry_(text, job) {
  for (let a = 1; ; a++) {
    try { return synth_(text, job); }
    catch (err) {
      const retryable = !err.status || err.status === 429 || err.status >= 500;
      if (!retryable || a >= 4) throw err;
      Utilities.sleep(3000 * Math.pow(2, a - 1));
    }
  }
}

function useVertex_() { return !!VERTEX_PROJECT; }

function synth_(text, job) {
  if (useVertex_()) return synthVertex_(text, job);
  const part = { type: 'text', text };
  if (job.style) part.annotations = [{ type: 'speech_metadata', style: job.style }];
  const r = api_('/interactions', {
    model: job.model,
    input: [{ type: 'user_input', content: [part] }],
    response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: SAMPLE_RATE },
    generation_config: { speech_config: [{ voice: job.voiceId }] },
  });
  const audios = (r.steps || []).filter(s => s.type === 'model_output')
    .reduce((a, s) => a.concat(s.content || []), []).filter(c => c.type === 'audio' && c.data);
  if (!audios.length) throw new Error('音声データが返ってきませんでした: ' + JSON.stringify(r).slice(0, 300));
  return audios[audios.length - 1].data;
}

// Vertex AI の generateContent。スタイル欄は無いので英語の指示文で前置きする
// （日本語の前置きは読み上げられてしまう。こえのアトリエで確認済みの形）
function synthVertex_(text, job) {
  if (!/^[a-z0-9.-]{1,80}$/.test(job.model)) throw new Error('モデルIDを確認してください: ' + job.model);
  const voice = job.voiceId;
  const voiceConfig = /^voice_/.test(voice) ? { voice } : { prebuiltVoiceConfig: { voiceName: voice } };
  const prompt = job.style ? `Read aloud in this manner (${job.style}): ${text}` : text;
  const r = api_(`/publishers/google/models/${job.model}:generateContent`, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig } },
  });
  const c = (r.candidates || [])[0];
  if (!c) throw new Error('音声データが返ってきませんでした: ' + JSON.stringify(r).slice(0, 300));
  const reason = c.finishReason || c.finish_reason;
  if (reason && reason !== 'STOP' && reason !== 'FINISH_REASON_UNSPECIFIED') {
    throw new Error(`音声生成が正常に完了しませんでした（${reason}）`);
  }
  const blobs = ((c.content || {}).parts || []).map(p => p.inlineData || p.inline_data).filter(b => b && b.data);
  if (!blobs.length) throw new Error('音声データが返ってきませんでした: ' + JSON.stringify(r).slice(0, 300));
  const b = blobs[blobs.length - 1];
  const rate = /rate=(\d+)/i.exec(b.mimeType || b.mime_type || '');
  if (rate && Number(rate[1]) !== SAMPLE_RATE) throw new Error('想定外のサンプルレートです: ' + rate[1]);
  return b.data;
}

function listVoices_() {
  const out = [];
  let token = '';
  for (let i = 0; i < 50; i++) {
    const q = useVertex_() ? 'type=VOICE_TYPE_PROMPTED&type=VOICE_TYPE_REPLICATED&' : '';
    const r = api_('/voices?' + q + 'page_size=100' + (token ? '&page_token=' + encodeURIComponent(token) : ''));
    out.push.apply(out, r.voices || []);
    token = r.next_page_token || r.nextPageToken || '';
    if (!token) break;
  }
  return out;
}

function voiceName_(v) { return v.display_name || v.displayName || ''; }

function resolveVoice_(input) {
  if (/^(voice_|voicekey_)/.test(input)) return input;
  const vs = listVoices_();
  const hit = vs.find(v => voiceName_(v) === input) || vs.find(v => voiceName_(v).toLowerCase() === input.toLowerCase());
  if (hit) return hit.id;
  // プリセット名（Kore など英字1語）以外で見つからないときは、原因が分かるように止める
  if (!/^[A-Za-z]+$/.test(input)) {
    throw new Error(`ボイス「${input}」が見つかりません。` + (useVertex_() ? 'AI Studio で作った声は Vertex では使えないので、Vertex 側で作り直してください。' : '') +
      ' 保存済み: ' + (vs.map(voiceName_).filter(Boolean).join(', ') || 'なし'));
  }
  return input; // プリセット名として使う
}

function api_(path, body) {
  // Vertex はこのスクリプトを実行する自分の Google アカウントで認証し、指定プロジェクトに課金する
  const headers = useVertex_()
    ? { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'x-goog-user-project': VERTEX_PROJECT }
    : { 'x-goog-api-key': GEMINI_API_KEY };
  const opt = { method: body ? 'post' : 'get', headers, muteHttpExceptions: true };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch((useVertex_() ? VERTEX_API : API) + path, opt);
  const code = res.getResponseCode(), t = res.getContentText();
  if (code !== 200) {
    let m = t; try { m = JSON.parse(t).error.message || t; } catch (e) {}
    const err = new Error(`${useVertex_() ? 'Vertex AI' : 'Gemini API'} ${code}: ${String(m).slice(0, 500)}`); err.status = code; throw err;
  }
  return JSON.parse(t);
}

// ---------- 音声データ ----------
// base64 を後で文字列のまま連結できるよう、バイト数を6の倍数にそろえる
function normalizePcm_(b64) {
  let bytes = Utilities.base64Decode(b64);
  if (bytes.length > 44 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70) bytes = stripWav_(bytes);
  const n = bytes.length - (bytes.length % 6);
  return { b64: Utilities.base64Encode(bytes.slice(0, n)), bytes: n };
}

function stripWav_(u) {
  let p = 12;
  while (p + 8 <= u.length) {
    const id = String.fromCharCode(u[p] & 255, u[p + 1] & 255, u[p + 2] & 255, u[p + 3] & 255);
    const size = (u[p + 4] & 255) | ((u[p + 5] & 255) << 8) | ((u[p + 6] & 255) << 16) | ((u[p + 7] & 255) << 24);
    if (id === 'data') return u.slice(p + 8, p + 8 + size);
    p += 8 + size;
  }
  return u.slice(44);
}

function assembleWav_(job) {
  const dataLen = job.parts.reduce((a, p) => a + p.bytes, 0) + GAP_BYTES * (job.parts.length - 1);
  const gap = Utilities.base64Encode(new Array(GAP_BYTES).fill(0));
  let s = Utilities.base64Encode(wavHeader_(dataLen));
  job.parts.forEach((p, i) => {
    if (i) s += gap;
    s += DriveApp.getFileById(p.fid).getBlob().getDataAsString();
  });
  const blob = Utilities.newBlob(Utilities.base64Decode(s), 'audio/wav', job.filename);
  s = null;
  const file = DriveApp.getFolderById(FOLDER_ID).createFile(blob);
  file.setDescription(job.text.slice(0, 4000));
  return file;
}

// 54バイトの WAV ヘッダ（3の倍数にするため 2バイトの JUNK チャンクを入れている）
function wavHeader_(dataLen) {
  const b = [];
  const str = s => { for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i)); };
  const u32 = v => b.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  const u16 = v => b.push(v & 255, (v >>> 8) & 255);
  str('RIFF'); u32(46 + dataLen); str('WAVE');
  str('fmt '); u32(16); u16(1); u16(1); u32(SAMPLE_RATE); u32(SAMPLE_RATE * 2); u16(2); u16(16);
  str('JUNK'); u32(2); u16(0);
  str('data'); u32(dataLen);
  return b.map(v => (v > 127 ? v - 256 : v));
}

// ---------- テキスト ----------
function splitText_(text) {
  const sentences = text.replace(/\r\n/g, '\n').match(/[^。！？!?\n]+[。！？!?」』）)]*\n*|\n+/g) || [text];
  const len = s => [...s].length;
  const chunks = []; let cur = '';
  sentences.forEach(s => {
    if (len(cur) + len(s) > CHUNK_CHARS && cur.trim()) { chunks.push(cur.trim()); cur = ''; }
    if (len(s) > CHUNK_CHARS) {
      const cs = [...s];
      for (let i = 0; i < cs.length; i += CHUNK_CHARS) chunks.push(cs.slice(i, i + CHUNK_CHARS).join('').trim());
      return;
    }
    cur += s;
  });
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}

function makeFilename_(text) {
  const ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss');
  const head = [...text.replace(/[\\/:*?"<>|\s]+/g, '')].slice(0, 15).join('');
  return `tts_${ts}_${head}.wav`;
}

// ---------- 保存まわり ----------
function workFolder_() {
  const id = props.getProperty('workFolderId');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  const f = DriveApp.getFolderById(FOLDER_ID).createFolder('_作業用（自動で消えます）');
  props.setProperty('workFolderId', f.getId());
  return f;
}

function saveJob_(job) {
  const content = JSON.stringify(job);
  const fid = props.getProperty('job_' + job.id);
  if (fid) { DriveApp.getFileById(fid).setContent(content); return; }
  const f = workFolder_().createFile(`job_${job.id}.json`, content, MimeType.PLAIN_TEXT);
  props.setProperty('job_' + job.id, f.getId());
}

function loadJob_(id) {
  const fid = props.getProperty('job_' + id);
  if (!fid) return null;
  try { return JSON.parse(DriveApp.getFileById(fid).getBlob().getDataAsString()); } catch (e) { return null; }
}

function removeJobFiles_(job) {
  job.parts.forEach(p => { try { DriveApp.getFileById(p.fid).setTrashed(true); } catch (e) {} });
  const fid = props.getProperty('job_' + job.id);
  if (fid) { try { DriveApp.getFileById(fid).setTrashed(true); } catch (e) {} }
  props.deleteProperty('job_' + job.id);
}

function queue_() { return JSON.parse(props.getProperty('queue') || '[]'); }
function dequeue_(id) {
  withLock_(() => props.setProperty('queue', JSON.stringify(queue_().filter(x => x !== id))));
}

function scheduleWorker_() {
  const exists = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'worker');
  if (!exists) ScriptApp.newTrigger('worker').timeBased().after(1000).create();
}

function setStatus_(id, st) { st.updatedAt = Date.now(); props.setProperty('st_' + id, JSON.stringify(st)); }
function getStatuses_(ids) {
  const out = {};
  ids.slice(0, 30).forEach(id => { const v = props.getProperty('st_' + id); out[id] = v ? JSON.parse(v) : null; });
  return out;
}
function cleanupStatuses_() {
  const all = props.getProperties(), limit = Date.now() - 7 * 24 * 3600 * 1000;
  Object.keys(all).forEach(k => {
    if (k.indexOf('st_') !== 0) return;
    try { if (JSON.parse(all[k]).updatedAt < limit) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function checkConfig_(token) {
  if (TOKEN === 'ここを合言葉に変更') return 'Code.gs の TOKEN（合言葉）を設定してください';
  if (!useVertex_() && /^ここに/.test(GEMINI_API_KEY)) return 'Code.gs の GEMINI_API_KEY を設定してください';
  // 前後の空白（コピペ時の混入）は無視して比較する
  const got = String(token == null ? '' : token).trim();
  if (got !== String(TOKEN).trim()) return `合言葉が違います（受信 ${got.length} 文字）`;
  return '';
}

function msg_(err) { return String((err && err.message) || err); }
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- 初回の動作確認（エディタで一度だけ実行） ----------
// 権限の許可画面が出たら許可してください。結果は「実行ログ」に出ます。
function setupCheck() {
  const bad = checkConfig_(TOKEN);
  if (bad) throw new Error(bad);
  Logger.log('保存先フォルダ: ' + DriveApp.getFolderById(FOLDER_ID).getName());
  const vs = listVoices_();
  Logger.log('保存済みボイス: ' + (vs.map(v => voiceName_(v) + ' (' + v.id + ')').join(', ') || 'なし'));
  Logger.log('接続先: ' + (useVertex_() ? 'Vertex AI（' + VERTEX_PROJECT + '、GCPクレジット対象）' : 'AI Studio（APIキー）'));
  try { Logger.log('「' + DEFAULT_VOICE + '」→ ' + resolveVoice_(DEFAULT_VOICE)); } catch (e) { Logger.log(msg_(e)); }
  ScriptApp.getProjectTriggers(); // トリガー作成の権限確認
  Logger.log('OK: 設定は正しく読み込めました');
}

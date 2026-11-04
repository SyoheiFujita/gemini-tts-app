// Gemini TTS 音声生成アプリ → Google ドライブ保存用の受け口
// 使い方は README.md の「ドライブ保存の設定」を参照してください。

const FOLDER_ID = '1aMnHYz0Ko3SUah4WIdbfOkMvEkXgM6l1';
// ↓ 好きな合言葉に変えてください（アプリの「合言葉」欄にも同じものを入れます）
const TOKEN = 'ここを合言葉に変更';

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (TOKEN === 'ここを合言葉に変更') return json_({ ok: false, error: 'Code.gs の TOKEN を設定してください' });
    if (req.token !== TOKEN) return json_({ ok: false, error: '合言葉が違います' });
    if (!req.data || !req.filename) return json_({ ok: false, error: 'データがありません' });

    const bytes = Utilities.base64Decode(req.data);
    const blob = Utilities.newBlob(bytes, req.mimeType || 'audio/mpeg', req.filename);
    const file = DriveApp.getFolderById(FOLDER_ID).createFile(blob);
    if (req.description) file.setDescription(String(req.description).slice(0, 4000));
    return json_({ ok: true, id: file.getId(), name: file.getName(), url: file.getUrl() });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// 動作確認用（ブラウザでURLを開くと表示される）
function doGet() {
  return json_({ ok: true, message: 'TTS 保存用スクリプトは動作中です' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

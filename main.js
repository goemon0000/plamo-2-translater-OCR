const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const screenshot = require('screenshot-desktop');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const path = require('path');
const { pathToFileURL } = require('url');
const fetch = require('node-fetch');

let mainWindow;
let overlayWindow;
let selectorWindow;
let captureRegions = [];
let previousTexts = {};
let isCapturing = false;
let captureInterval = null;
let isProcessing = false; // 処理中フラグ
const TESSERACT_WORKER_RELATIVE_PATH = path.join('node_modules', 'tesseract.js', 'dist', 'worker.min.js');
const TESSERACT_CORE_RELATIVE_PATH = path.join('node_modules', 'tesseract.js-core', 'tesseract-core.wasm.js');

function getTesseractPaths() {
  const appPath = app && typeof app.getAppPath === 'function' ? app.getAppPath() : __dirname;
  const workerPath = pathToFileURL(path.join(appPath, TESSERACT_WORKER_RELATIVE_PATH)).href;
  const corePath = pathToFileURL(path.join(appPath, TESSERACT_CORE_RELATIVE_PATH)).href;
  const langPath = pathToFileURL(`${appPath}${path.sep}`).href;

  return { workerPath, corePath, langPath };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 450,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    alwaysOnTop: true,
    frame: true,
    title: 'ゲーム翻訳オーバーレイ'
  });

  mainWindow.loadFile('index.html');
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  
  overlayWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    focusable: false,
    hasShadow: false,
    resizable: false
  });

  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile('overlay.html');
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function createSelectorWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  
  selectorWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    focusable: true,
    hasShadow: false,
    resizable: false
  });

  selectorWindow.loadFile('selector.html');
  selectorWindow.setAlwaysOnTop(true, 'screen-saver');
  selectorWindow.hide();
  
  selectorWindow.on('closed', () => {
    selectorWindow = null;
  });
}

app.whenReady().then(() => {
  createMainWindow();
  createOverlayWindow();
  createSelectorWindow();

  // ショートカット登録
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    toggleCapture();
  });

  globalShortcut.register('CommandOrControl+Shift+R', () => {
    startRegionSelection();
  });

  console.log('アプリケーション起動完了');
});

app.on('window-all-closed', () => {
  if (captureInterval) {
    clearInterval(captureInterval);
  }
  globalShortcut.unregisterAll();
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// 領域選択開始
ipcMain.on('start-region-selection', () => {
  startRegionSelection();
});

function startRegionSelection() {
  if (selectorWindow) {
    selectorWindow.show();
    selectorWindow.focus();
  }
}

// 領域選択完了
ipcMain.on('region-selected', (event, region) => {
  if (selectorWindow) {
    selectorWindow.hide();
  }
  
  const newRegion = {
    ...region,
    id: Date.now()
  };
  captureRegions.push(newRegion);
  console.log('領域追加:', newRegion);
  
  if (overlayWindow) {
    overlayWindow.webContents.send('update-regions', captureRegions);
  }
  if (mainWindow) {
    mainWindow.webContents.send('regions-updated', captureRegions);
  }
});

// 領域選択キャンセル
ipcMain.on('cancel-selection', () => {
  if (selectorWindow) {
    selectorWindow.hide();
  }
});

// 領域追加（手動入力）
ipcMain.on('add-region', (event, region) => {
  const newRegion = {
    ...region,
    id: Date.now()
  };
  captureRegions.push(newRegion);
  console.log('領域追加:', newRegion);
  
  if (overlayWindow) {
    overlayWindow.webContents.send('update-regions', captureRegions);
  }
  if (mainWindow) {
    mainWindow.webContents.send('regions-updated', captureRegions);
  }
});

// 領域削除
ipcMain.on('remove-region', (event, id) => {
  captureRegions = captureRegions.filter(r => r.id !== id);
  delete previousTexts[id];
  console.log('領域削除:', id);
  
  if (overlayWindow) {
    overlayWindow.webContents.send('update-regions', captureRegions);
    overlayWindow.webContents.send('remove-translation', id);
  }
  if (mainWindow) {
    mainWindow.webContents.send('regions-updated', captureRegions);
  }
});

// キャプチャ開始/停止
ipcMain.on('toggle-capture', () => {
  toggleCapture();
});

function toggleCapture() {
  isCapturing = !isCapturing;
  
  if (mainWindow) {
    mainWindow.webContents.send('capture-status', isCapturing);
  }
  
  if (isCapturing) {
    console.log('=== キャプチャ開始 ===');
    startCaptureLoop();
  } else {
    console.log('=== キャプチャ停止 ===');
    if (captureInterval) {
      clearInterval(captureInterval);
      captureInterval = null;
    }
    isProcessing = false; // フラグをリセット
  }
}

function startCaptureLoop() {
  if (captureInterval) {
    clearInterval(captureInterval);
  }
  
  // 最初の実行
  processAllRegions();
  
  // 0.2秒ごとにチェック（前の処理が終わっていれば実行）
  captureInterval = setInterval(() => {
    if (!isCapturing) return;
    if (isProcessing) {
      // スキップするが、ログは出さない
      return;
    }
    processAllRegions();
  }, 200);
}

async function processAllRegions() {
  if (isProcessing) return;
  if (captureRegions.length === 0) return;
  
  isProcessing = true;
  
  try {
    for (const region of captureRegions) {
      try {
        await captureAndTranslate(region);
      } catch (err) {
        console.error(`[領域${region.id}] 処理エラー:`, err.message);
      }
    }
  } finally {
    isProcessing = false;
  }
}

async function captureAndTranslate(region) {
  try {
    // スクリーンショット取得
    const imgBuffer = await screenshot({ format: 'png' });
    
    // OCR実行
    const text = await performOCR(imgBuffer, region);
    
    if (!text || text.trim() === '') {
      return;
    }

    // 前回と同じなら無視
    if (previousTexts[region.id] === text) {
      return;
    }
    
    console.log(`\n[領域${region.id}] 📝 テキスト検出: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);
    previousTexts[region.id] = text;

    // 翻訳実行
    const translated = await translateText(text);
    console.log(`[領域${region.id}] ✅ 翻訳完了: ${translated.substring(0, 100)}${translated.length > 100 ? '...' : ''}\n`);
    
    // オーバーレイに表示
    if (overlayWindow) {
      overlayWindow.webContents.send('update-translation', {
        id: region.id,
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        text: translated
      });
    }

  } catch (err) {
    console.error(`[領域${region.id}] ❌ エラー:`, err.message);
  }
}

async function performOCR(imageBuffer, region) {
  try {
    console.log(`[OCR] 領域サイズ: ${region.width}x${region.height}px`);
    
    const baseImage = sharp(imageBuffer).extract({
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height
    });
    
    const stats = await baseImage.clone().greyscale().stats();
    const meanLuma = stats.channels[0].mean;
    
    // sharpで領域を切り出し + 前処理
    let pipeline = baseImage
      // 画像を3倍に拡大（OCR精度向上）
      .resize(region.width * 3, region.height * 3, {
        kernel: 'lanczos3'
      })
      // グレースケール化
      .greyscale()
      // コントラスト強化
      .normalize();

    // 背景が暗い場合は反転して黒文字/白背景に寄せる
    if (meanLuma < 128) {
      pipeline = pipeline.negate();
    }

    // 二値化で文字エッジを強調
    const croppedBuffer = await pipeline
      .threshold(170)
      // シャープネス
      .sharpen()
      .toBuffer();

    const { workerPath, corePath, langPath } = getTesseractPaths();
    
    // OCR実行（英語のみで読み取り）
    const { data: { text } } = await Tesseract.recognize(
      croppedBuffer, 
      'eng', // 英語のみ
      {
        // PSMモード6: 複数行対応
        psm: 6,
        // OCRエンジンモード: LSTM
        oem: 1,
        // 言語データのパス（ローカル優先）
        langPath,
        // ローカルのTesseractワーカー/コアを明示
        workerPath,
        corePath,
        // キャッシュを有効化
        cachePath: './.cache',
        // DPIを明示して精度を安定化
        user_defined_dpi: '300',
        // 空白保持
        preserve_interword_spaces: '1'
      }
    );
    
    const cleanedText = text.trim();
    console.log(`[OCR] 読取結果（英語）: "${cleanedText.substring(0, 100)}"`);
    return cleanedText;
  } catch (err) {
    console.error('OCRエラー:', err.message);
    return '';
  }
}

async function translateText(text) {
  const apiUrl = 'http://127.0.0.1:1234/v1/chat/completions';
  
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // モデル名はLM Studioで表示されている名前に合わせてください
        model: 'plamo-2-translate',
        messages: [
          {
            role: 'user',
            content: `次の英語を日本語に翻訳してください。翻訳結果のみを出力してください:\n\n${text}`
          }
        ],
        max_tokens: 500,
        temperature: 0.3
      }),
      timeout: 30000 // 30秒タイムアウト
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    
    if (!data.choices || !data.choices[0]) {
      throw new Error('APIレスポンスが不正です');
    }
    
    return data.choices[0].message.content.trim();
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error('[翻訳エラー] LM Studioサーバーに接続できません。');
    } else {
      console.error('[翻訳エラー]', err.message);
    }
    return `[翻訳失敗] ${text}`;
  }
}

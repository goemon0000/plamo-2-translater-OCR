const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const screenshot = require('screenshot-desktop');
const { fork } = require('child_process');
const path = require('path');
const { net } = require('electron');

let mainWindow;
let overlayWindow;
let selectorWindow;
let captureRegions = [];
let previousTexts = {};
let isCapturing = false;
let captureInterval = null;
let isProcessing = false; // 処理中フラグ
let ocrWorker = null; // OCRワーカープロセス

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
      contextIsolation: false,
      enableRemoteModule: true
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
  
  // OCRワーカーを起動
  startOCRWorker();

  // ショートカット登録
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    toggleCapture();
  });

  globalShortcut.register('CommandOrControl+Shift+R', () => {
    startRegionSelection();
  });

  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    console.log('=== 強制終了ショートカット ===');
    if (captureInterval) {
      clearInterval(captureInterval);
      captureInterval = null;
    }
    if (ocrWorker) {
      ocrWorker.kill();
    }
    app.exit(0);
  });

  console.log('アプリケーション起動完了');
});

function startOCRWorker() {
  const workerPath = path.join(__dirname, 'ocr-worker.js');
  ocrWorker = fork(workerPath);
  
  ocrWorker.on('error', (err) => {
    console.error('[OCR Worker] エラー:', err);
  });
  
  ocrWorker.on('exit', (code) => {
    console.log(`[OCR Worker] 終了 (コード: ${code})`);
    // 異常終了した場合は再起動
    if (code !== 0 && isCapturing) {
      console.log('[OCR Worker] 再起動します...');
      setTimeout(() => startOCRWorker(), 1000);
    }
  });
  
  console.log('[OCR Worker] 起動しました');
}

app.on('window-all-closed', () => {
  if (captureInterval) {
    clearInterval(captureInterval);
  }
  if (ocrWorker) {
    ocrWorker.kill();
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
  
  // DPIスケーリング係数を取得
  const display = screen.getPrimaryDisplay();
  const scaleFactor = display.scaleFactor || 1;
  
  console.log(`[DPI] スケール係数: ${scaleFactor}`);
  
  // 物理ピクセル座標に変換
  const newRegion = {
    x: Math.round(region.x * scaleFactor),
    y: Math.round(region.y * scaleFactor),
    width: Math.round(region.width * scaleFactor),
    height: Math.round(region.height * scaleFactor),
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

    // 正規化：空白を統一して比較
    const normalizedText = text.trim().replace(/\s+/g, ' ');
    const previousNormalized = previousTexts[region.id] ? previousTexts[region.id].replace(/\s+/g, ' ') : '';
    
    // 前回と同じなら無視
    if (previousNormalized === normalizedText) {
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
  return new Promise((resolve, reject) => {
    if (!ocrWorker) {
      console.error('[OCR] ワーカーが起動していません');
      resolve('');
      return;
    }
    
    const timeout = setTimeout(() => {
      console.error('[OCR] タイムアウト');
      resolve('');
    }, 10000); // 10秒タイムアウト
    
    const messageHandler = (msg) => {
      if (msg.type === 'result') {
        clearTimeout(timeout);
        ocrWorker.removeListener('message', messageHandler);
        resolve(msg.text);
      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        ocrWorker.removeListener('message', messageHandler);
        console.error('[OCR] エラー:', msg.error);
        resolve('');
      }
    };
    
    ocrWorker.on('message', messageHandler);
    
    // 画像バッファを配列に変換して送信
    ocrWorker.send({
      type: 'ocr',
      imageBuffer: Array.from(imageBuffer),
      region: region
    });
  });
}

async function translateText(text) {
  const apiUrl = 'http://127.0.0.1:1234/v1/chat/completions';
  
  return new Promise((resolve, reject) => {
    const requestData = JSON.stringify({
      model: 'plamo-2-translate',
      messages: [
        {
          role: 'system',
          content: 'あなたはプロの翻訳者です。英語のテキストを自然な日本語に翻訳してください。翻訳結果のみを出力し、余計な説明や装飾（テーブル形式、箇条書きなど）は付けないでください。'
        },
        {
          role: 'user',
          content: text
        }
      ],
      max_tokens: 300,
      temperature: 0.3
    });

    const request = net.request({
      method: 'POST',
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: 1234,
      path: '/v1/chat/completions'
    });

    request.setHeader('Content-Type', 'application/json');

    let responseData = '';
    let timeoutId = null;

    // タイムアウト処理（30秒）
    timeoutId = setTimeout(() => {
      request.abort();
      console.error('[翻訳エラー] タイムアウト');
      resolve(`[翻訳失敗] ${text}`);
    }, 30000);

    request.on('response', (response) => {
      response.on('data', (chunk) => {
        responseData += chunk.toString();
      });

      response.on('end', () => {
        clearTimeout(timeoutId);
        
        try {
          if (response.statusCode !== 200) {
            throw new Error(`HTTP ${response.statusCode}: ${responseData}`);
          }

          const data = JSON.parse(responseData);
          
          if (!data.choices || !data.choices[0]) {
            throw new Error('APIレスポンスが不正です');
          }
          
          resolve(data.choices[0].message.content.trim());
        } catch (err) {
          console.error('[翻訳エラー]', err.message);
          resolve(`[翻訳失敗] ${text}`);
        }
      });

      response.on('error', (err) => {
        clearTimeout(timeoutId);
        console.error('[翻訳エラー] レスポンスエラー:', err.message);
        resolve(`[翻訳失敗] ${text}`);
      });
    });

    request.on('error', (err) => {
      clearTimeout(timeoutId);
      if (err.message.includes('ECONNREFUSED')) {
        console.error('[翻訳エラー] LM Studioサーバーに接続できません。ポート1234が開いているか確認してください。');
      } else {
        console.error('[翻訳エラー] リクエストエラー:', err.message);
      }
      resolve(`[翻訳失敗] ${text}`);
    });

    try {
      request.write(requestData);
      request.end();
    } catch (err) {
      clearTimeout(timeoutId);
      console.error('[翻訳エラー] リクエスト送信エラー:', err.message);
      resolve(`[翻訳失敗] ${text}`);
    }
  });
}
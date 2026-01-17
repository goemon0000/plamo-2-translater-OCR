// OCR処理専用のワーカープロセス
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

// 簡易ロガー
const logFile = path.join(__dirname, 'logs', `ocr-${new Date().toISOString().split('T')[0]}.log`);
if (!fs.existsSync(path.dirname(logFile))) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
}

function log(message) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  const logLine = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(logFile, logLine, 'utf8');
  } catch (err) {
    // 無視
  }
}

process.on('message', async (msg) => {
  if (msg.type === 'ocr') {
    try {
      const result = await performOCR(msg.imageBuffer, msg.region);
      process.send({ type: 'result', text: result });
    } catch (err) {
      log(`エラー: ${err.message}`);
      process.send({ type: 'error', error: err.message });
    }
  }
});

async function performOCR(imageBuffer, region) {
  try {
    log(`OCR開始: 領域 ${region.width}x${region.height}px`);
    
    const buffer = Buffer.from(imageBuffer);
    
    // 元画像のメタデータ取得
    const metadata = await sharp(buffer).metadata();
    log(`元画像: ${metadata.width}x${metadata.height}px`);
    
    // 領域が画像境界を超えないように調整
    const safeRegion = {
      left: Math.max(0, Math.min(region.x, metadata.width - 1)),
      top: Math.max(0, Math.min(region.y, metadata.height - 1)),
      width: Math.min(region.width, metadata.width - region.x),
      height: Math.min(region.height, metadata.height - region.y)
    };
    
    const baseImage = sharp(buffer).extract(safeRegion);
    
    const stats = await baseImage.clone().greyscale().stats();
    const meanLuma = stats.channels[0].mean;
    log(`平均輝度: ${meanLuma.toFixed(1)}`);
    
    // sharpで領域を切り出し + 前処理
    let pipeline = baseImage
      // 画像を4倍に拡大（OCR精度向上）
      .resize(safeRegion.width * 4, safeRegion.height * 4, {
        kernel: 'lanczos3'
      })
      // グレースケール化
      .greyscale()
      // コントラスト強化
      .normalize();

    // 背景が暗い場合は反転して黒文字/白背景に寄せる
    if (meanLuma < 140) {
      log('画像を反転');
      pipeline = pipeline.negate();
    }

    // 適応的二値化で文字エッジを強調
    const croppedBuffer = await pipeline
      .threshold(128)
      .sharpen({ sigma: 2.0 })
      .toBuffer();

    // OCR実行（英語のみで読み取り）
    const { data: { text, confidence } } = await Tesseract.recognize(
      croppedBuffer, 
      'eng',
      {
        psm: Tesseract.PSM.SINGLE_BLOCK,
        oem: Tesseract.OEM.LSTM_ONLY
      }
    );
    
    const cleanedText = text.trim();
    log(`OCR結果 (信頼度: ${confidence.toFixed(1)}%): "${cleanedText}"`);
    return cleanedText;
  } catch (err) {
    log(`OCRエラー: ${err.message}`);
    throw err;
  }
}

log('[OCR Worker] 起動完了');
console.log('[OCR Worker] 起動完了');

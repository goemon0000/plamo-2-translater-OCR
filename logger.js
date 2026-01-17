const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    this.logDir = path.join(__dirname, 'logs');
    this.logFile = path.join(this.logDir, `app-${this.getDateString()}.log`);
    
    // ログディレクトリを作成
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  getDateString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  getTimeString() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
  }

  writeToFile(level, message) {
    const timestamp = this.getTimeString();
    const logLine = `[${timestamp}] [${level}] ${message}\n`;
    
    try {
      fs.appendFileSync(this.logFile, logLine, 'utf8');
    } catch (err) {
      // ファイル書き込みエラーは無視
    }
  }

  // コンソールにも表示する重要なログ
  info(message) {
    console.log(message);
    this.writeToFile('INFO', message);
  }

  // エラーログ
  error(message) {
    console.error(message);
    this.writeToFile('ERROR', message);
  }

  // ファイルのみに記録する詳細ログ
  debug(message) {
    this.writeToFile('DEBUG', message);
  }

  // 警告ログ
  warn(message) {
    console.warn(message);
    this.writeToFile('WARN', message);
  }
}

module.exports = new Logger();

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binDir = path.join(__dirname, '..', '..', 'data', 'bin');

const RELEASE_ASSET_BY_PLATFORM = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux: 'yt-dlp'
};

function getAssetName() {
  const asset = RELEASE_ASSET_BY_PLATFORM[process.platform];
  if (!asset) {
    throw new Error(`Plateforme non supportée pour yt-dlp: ${process.platform}`);
  }
  return asset;
}

let cachedBinaryPath = null;

export async function ensureYtDlpBinary() {
  if (cachedBinaryPath && fs.existsSync(cachedBinaryPath)) {
    return cachedBinaryPath;
  }

  const assetName = getAssetName();
  const binaryPath = path.join(binDir, assetName);

  const existingSize = fs.existsSync(binaryPath) ? fs.statSync(binaryPath).size : 0;
  if (existingSize > 1_000_000) {
    console.log(`✅ yt-dlp déjà présent (${binaryPath}, ${existingSize} octets)`);
    cachedBinaryPath = binaryPath;
    return binaryPath;
  }

  console.log(`⬇️ Téléchargement de yt-dlp (${assetName})...`);
  fs.mkdirSync(binDir, { recursive: true });
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Téléchargement de yt-dlp échoué: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1_000_000) {
    throw new Error(`Binaire yt-dlp téléchargé trop petit (${buffer.length} octets), probablement corrompu`);
  }
  fs.writeFileSync(binaryPath, buffer, { mode: 0o755 });
  if (process.platform !== 'win32') {
    fs.chmodSync(binaryPath, 0o755);
  }
  console.log(`✅ yt-dlp téléchargé (${binaryPath}, ${buffer.length} octets)`);

  cachedBinaryPath = binaryPath;
  return binaryPath;
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const CATALOG_DIR = path.join(DATA_DIR, 'catalog');
export const ENRICHED_DIR = path.join(DATA_DIR, 'enriched');
export const CHECKPOINT_PATH = path.join(DATA_DIR, 'checkpoint.json');
export const CATALOG_FILE = path.join(CATALOG_DIR, 'javguru_catalog_part1.json');

export const BASE_URL = 'https://jav.guru';

export const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': BASE_URL,
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin'
};

// Safe GitHub file partition size limit: 85 MB (GitHub hard limit is 100 MB)
export const MAX_PART_SIZE_BYTES = 85 * 1024 * 1024;

// Catalog partition size limit: 75 MB per catalog file
export const MAX_CATALOG_PART_BYTES = 75 * 1024 * 1024;

// Polite rate limiting & timeouts
export const DEFAULT_DELAY_MS = 250;
export const TIMEOUT_MS = 25000;
export const MAX_RETRIES = 3;

/**
 * JAV.guru Catalog Indexer
 * Crawls https://jav.guru across all ~5,791 pages (~139,000 titles)
 * Builds the complete deduplicated catalog.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpClient } from './client.js';
import { parseCatalogPage, parseCatalogPagination } from './parser.js';
import {
    CATALOG_DIR,
    CATALOG_FILE,
    CHECKPOINT_PATH,
    DEFAULT_DELAY_MS
} from './config.js';

const __filename = fileURLToPath(import.meta.url);

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        isTest: false,
        maxPages: Infinity,
        startPage: 1,
        delayMs: DEFAULT_DELAY_MS
    };

    let explicitPages = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--test') {
            options.isTest = true;
            if (!explicitPages) options.maxPages = 2;
        } else if (args[i] === '--all') {
            options.maxPages = Infinity;
        } else if (args[i] === '--pages' && args[i + 1]) {
            options.maxPages = parseInt(args[i + 1], 10);
            explicitPages = true;
            i++;
        } else if (args[i] === '--start' && args[i + 1]) {
            options.startPage = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--delay' && args[i + 1]) {
            options.delayMs = parseInt(args[i + 1], 10);
            i++;
        }
    }

    return options;
}

function loadCheckpoint() {
    if (fs.existsSync(CHECKPOINT_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
        } catch {}
    }
    return {
        catalog: {
            total_items: 0,
            last_run: null,
            total_pages: 5791
        },
        enrichment: {
            total_enriched: 0,
            last_index: 0,
            failed_ids: [],
            last_run: null
        }
    };
}

function saveCheckpoint(state) {
    if (!fs.existsSync(path.dirname(CHECKPOINT_PATH))) {
        fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
    }
    const tempPath = `${CHECKPOINT_PATH}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tempPath, CHECKPOINT_PATH);
}

function saveCatalogFile(filePath, items) {
    if (!fs.existsSync(path.dirname(filePath))) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(items, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
}

export async function runIndexer() {
    const opts = parseArgs();
    const client = new HttpClient({ delayMs: opts.delayMs });

    if (!fs.existsSync(CATALOG_DIR)) {
        fs.mkdirSync(CATALOG_DIR, { recursive: true });
    }

    const checkpoint = loadCheckpoint();
    const outputFile = opts.isTest
        ? path.join(CATALOG_DIR, 'javguru_catalog_test.json')
        : CATALOG_FILE;

    const existingMap = new Map();
    if (fs.existsSync(outputFile)) {
        try {
            const currentItems = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
            if (Array.isArray(currentItems)) {
                for (const it of currentItems) {
                    if (it && it.id != null) existingMap.set(String(it.id), it);
                }
            }
        } catch {}
    }

    console.log(`\n======================================================`);
    console.log(`         🚀 JAV.GURU CATALOG INDEXER                  `);
    console.log(`======================================================`);
    console.log(`- Mode:         ${opts.isTest ? 'TEST' : 'PRODUCTION'}`);
    console.log(`- Max Pages:    ${opts.maxPages === Infinity ? 'ALL' : opts.maxPages}`);
    console.log(`- Start Page:   ${opts.startPage}`);
    console.log(`- Output File:  ${path.basename(outputFile)}`);
    console.log(`- Existing:     ${existingMap.size} titles`);
    console.log(`======================================================\n`);

    // Fetch page 1 to detect total pages
    const firstHtml = await client.getCatalogPage(opts.startPage);
    if (!firstHtml) {
        console.error(`[Indexer] ❌ Could not load catalog page ${opts.startPage}.`);
        return;
    }

    const detectedTotalPages = parseCatalogPagination(firstHtml, 5791);
    const targetPages = (opts.maxPages === Infinity || opts.maxPages > detectedTotalPages)
        ? detectedTotalPages
        : opts.maxPages;

    console.log(`-> Detected ${detectedTotalPages} total pages on JAV.guru (Crawl target: ${targetPages} pages)\n`);

    let totalFound = 0;
    let totalNew = 0;

    const flushProgress = (pagesIndexed) => {
        const allItems = Array.from(existingMap.values());
        saveCatalogFile(outputFile, allItems);
        if (!opts.isTest) {
            checkpoint.catalog = {
                last_run: new Date().toISOString(),
                total_items: allItems.length,
                total_pages: detectedTotalPages,
                pages_indexed: pagesIndexed
            };
            saveCheckpoint(checkpoint);
        }
        return allItems;
    };

    let lastPageDone = opts.startPage - 1;
    let isTerminating = false;
    const handleExit = () => {
        if (isTerminating) return;
        isTerminating = true;
        console.log(`\n[Indexer] 💾 Saving catalog progress before exit (page ${lastPageDone})...`);
        flushProgress(lastPageDone);
        process.exit(0);
    };
    process.on('SIGINT', handleExit);
    process.on('SIGTERM', handleExit);

    for (let page = opts.startPage; page <= targetPages; page++) {
        process.stdout.write(`  [Page ${page}/${targetPages}]... `);

        const html = (page === opts.startPage) 
            ? firstHtml 
            : await client.getCatalogPage(page);

        if (!html) {
            console.log(`❌ Failed to fetch page HTML.`);
            continue;
        }

        const cards = parseCatalogPage(html);
        let pageNew = 0;

        for (const item of cards) {
            totalFound++;
            const idKey = String(item.id);
            if (!existingMap.has(idKey)) {
                existingMap.set(idKey, item);
                pageNew++;
                totalNew++;
            } else {
                const old = existingMap.get(idKey);
                existingMap.set(idKey, { ...old, ...item });
            }
        }

        lastPageDone = page;
        console.log(`✅ ${cards.length} cards (${pageNew} new).`);

        if (page % 100 === 0) {
            flushProgress(page);
            console.log(`  [Indexer] 💾 Checkpoint saved (${existingMap.size} titles so far)`);
        }
    }

    const allItems = flushProgress(targetPages);

    console.log(`\n======================================================`);
    console.log(`🎉 Catalog Indexing Complete!`);
    console.log(`- Total Titles Indexed: ${allItems.length} (${totalNew} newly discovered)`);
    console.log(`- Output File:          ${outputFile}`);
    console.log(`======================================================\n`);
}

// Auto-run if executed directly
if (process.argv[1] && (path.resolve(process.argv[1]) === path.resolve(__filename) || process.argv[1].endsWith('indexer.js'))) {
    runIndexer().catch(err => {
        console.error('[Indexer] ❌ Fatal error:', err);
        process.exit(1);
    });
}

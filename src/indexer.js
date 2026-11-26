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
        isCheck: false,
        resume: false,
        maxPages: Infinity,
        startPage: 1,
        maxMinutes: 270,
        delayMs: DEFAULT_DELAY_MS
    };

    let explicitPages = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--test') {
            options.isTest = true;
            if (!explicitPages) options.maxPages = 2;
        } else if (args[i] === '--check') {
            options.isCheck = true;
        } else if (args[i] === '--resume') {
            options.resume = true;
        } else if (args[i] === '--all') {
            options.maxPages = Infinity;
        } else if (args[i] === '--pages' && args[i + 1]) {
            options.maxPages = parseInt(args[i + 1], 10);
            explicitPages = true;
            i++;
        } else if (args[i] === '--start' && args[i + 1]) {
            options.startPage = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--max-minutes' && args[i + 1]) {
            const m = parseFloat(args[i + 1]);
            if (!isNaN(m) && m > 0) options.maxMinutes = m;
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
    const checkpoint = loadCheckpoint();

    if (opts.isCheck) {
        const cat = checkpoint.catalog || {};
        if (cat.is_complete === true) {
            console.log('COMPLETE');
            process.exit(1);
        }
        const nextPage = (cat.pages_indexed || 0) + 1;
        const totalPages = cat.total_pages || 5792;
        if (cat.pages_indexed && cat.pages_indexed >= totalPages) {
            console.log('COMPLETE');
            process.exit(1);
        }
        console.log(`CONTINUE ${nextPage}/${totalPages}`);
        process.exit(0);
    }

    if (opts.resume && !opts.isTest && checkpoint.catalog?.pages_indexed) {
        if (checkpoint.catalog.is_complete) {
            console.log(`[Indexer] ✅ Catalog already marked 100% complete (${checkpoint.catalog.total_items} titles).`);
            return;
        }
        opts.startPage = Math.max(opts.startPage, checkpoint.catalog.pages_indexed + 1);
    }

    const startTime = Date.now();
    const maxExecutionMs = opts.maxMinutes * 60 * 1000;
    const client = new HttpClient({ delayMs: opts.delayMs });

    if (!fs.existsSync(CATALOG_DIR)) {
        fs.mkdirSync(CATALOG_DIR, { recursive: true });
    }

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
    console.log(`- Start Page:   ${opts.startPage}${opts.resume ? ' (RESUMED)' : ''}`);
    console.log(`- Max Minutes:  ${opts.maxMinutes} mins`);
    console.log(`- Output File:  ${path.basename(outputFile)}`);
    console.log(`- Existing:     ${existingMap.size} titles`);
    console.log(`======================================================\n`);

    const fallbackTotal = checkpoint.catalog?.total_pages || 5792;
    const firstHtml = await client.getCatalogPage(opts.startPage);
    if (!firstHtml) {
        console.error(`[Indexer] ❌ Could not load catalog page ${opts.startPage}.`);
        process.exit(1);
    }

    const detectedTotalPages = parseCatalogPagination(firstHtml, fallbackTotal);
    const targetPages = (opts.maxPages === Infinity || opts.maxPages > detectedTotalPages)
        ? detectedTotalPages
        : opts.maxPages;

    console.log(`-> Detected ${detectedTotalPages} total pages on JAV.guru (Crawl target: pages ${opts.startPage}..${targetPages})\n`);

    let totalFound = 0;
    let totalNew = 0;

    const flushProgress = (pagesIndexed, isComplete = false) => {
        const allItems = Array.from(existingMap.values());
        saveCatalogFile(outputFile, allItems);
        if (!opts.isTest) {
            checkpoint.catalog = {
                last_run: new Date().toISOString(),
                total_items: allItems.length,
                total_pages: detectedTotalPages,
                pages_indexed: pagesIndexed,
                is_complete: isComplete
            };
            saveCheckpoint(checkpoint);
        }
        return allItems;
    };

    let lastPageDone = opts.startPage - 1;
    let timedOut = false;
    let isTerminating = false;
    const handleExit = () => {
        if (isTerminating) return;
        isTerminating = true;
        console.log(`\n[Indexer] 💾 Saving catalog progress before exit (page ${lastPageDone})...`);
        flushProgress(lastPageDone, false);
        process.exit(0);
    };
    process.on('SIGINT', handleExit);
    process.on('SIGTERM', handleExit);

    for (let page = opts.startPage; page <= targetPages; page++) {
        if (Date.now() - startTime >= maxExecutionMs) {
            console.log(`\n⏳ Max execution time reached (${opts.maxMinutes} mins) at page ${lastPageDone}/${targetPages}. Saving gracefully for resume...`);
            timedOut = true;
            break;
        }

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
            flushProgress(page, false);
            console.log(`  [Indexer] 💾 Checkpoint saved (${existingMap.size} titles so far)`);
        }
    }

    const completedAll = !timedOut && lastPageDone >= targetPages;
    const allItems = flushProgress(lastPageDone, completedAll);

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
